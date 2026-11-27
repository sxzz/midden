// A query of the query language as the library list runs it. One engine:
// whatever the list's own filter (`CollectionFilter`) can say is said by
// it, so a query made only of such conditions is the very SQL, and plan,
// of the same structured parameters. The rest becomes SQL over the list's
// `k` (catalog) and `l` (library), fully parameterised, added to the
// filter's conditions (`QueryExtra`):
//
// - terms that name a set of catalog rows through an index (side tables,
//   search, authors, tags, follows) become `k.id IN (…)`; an OR of such sets
//   is their UNION, an AND inside one their INTERSECT;
// - terms about the row itself (media, language, dates) are tests on it;
// - a conjunction lists sets first, then the cheap tests, then the costly
//   ones, so the indexes narrow before anything is read row by row;
// - `-` is `NOT` (`NOT IN` for a set), null-safe.
//
// The keyword search: the bare words (and phrases) of the top level, not
// negated, are one search as the `q` filter runs it, ranked; words under OR
// or `-` are sets of what they find, without the fuzzy tier.
import { eq, sql, type SQL } from 'drizzle-orm'
import { folders, tags } from '#db/schema.ts'
import { followSetSQL, type FollowSet } from '#library/follows.ts'
import {
  authorKey,
  checkFilter,
  mediaSQL,
  parseAuthorKey,
  postTypeSQL,
  relatedEdgesSQL,
  rootTypeSQL,
  savedSince,
  taggedSQL,
  type CollectionFilter,
  type Identity,
  type QueryExtra,
} from '#library/list.ts'
import { isUUID } from '#library/read.ts'
import { fold } from '#library/search-text.ts'
import { searchHits } from '#library/search.ts'
import { list } from '#library/views.ts'
import {
  LIMITS,
  onlyNegative,
  OWNER_LIMITS,
  parseQuery,
  QueryError,
  type Leaf,
  type Limits,
  type QueryNode,
} from './ast.ts'
import { printQuery } from './print.ts'
import type { Executor } from '#db/client.ts'

const DIGITS = /^\d+$/
const SPACE = /\s/

/**
 * A phrase of one word is that word: its quotes only keep it from reading
 * as syntax (`"OR"`, `"-x"`, `"#x"`, `"from:x"`).
 */
const oneWord = (phrase: string) => !SPACE.test(fold(phrase).trim())

/** The entity types of the archive's platforms. */
export interface Types {
  /**
   * Read from the catalog rather than the platforms (tests, scripts): a
   * platform it has no rows of yet is taken to have posts and profiles.
   */
  open?: boolean
  platforms: string[]
  posts: string[]
  accounts: string[]
}

export interface CompileOptions {
  db: Executor
  types: Types
  /** Posts, accounts, or both (aggregation). */
  kind: 'posts' | 'accounts' | 'all'
  /** The filter the request's other parameters give; the query adds to it. */
  filter: CollectionFilter
  /** The other parameters scope it (dates, author, folder, tag, follows). */
  scoped?: boolean
  /** IANA zone of the query's dates; UTC by default. */
  timeZone?: string
  now?: number
  /** An agent's limits (the default), or the owner's (`OWNER_LIMITS`). */
  limits?: Limits
  /**
   * Names the query's `WITH` items start with, so that two compiled
   * queries can share a statement.
   */
  prefix?: string
  /** The folder this query is saved as: it may not name itself. */
  within?: string
}

export interface CompiledQuery {
  node: QueryNode
  /** The canonical query. */
  parsed: string
  /** The request's filter with what the query could say in its terms. */
  filter: CollectionFilter
  extra?: QueryExtra
}

/**
 * Inside the compiler only: what a folder whose query is empty selects
 * (everything), and its negation. Never printed.
 */
type Constant = { type: 'all' | 'none'; start: number; end: number }
type Expanded = QueryNode | Constant
const isConstant = (node: Expanded): node is Constant =>
  node.type === 'all' || node.type === 'none'

/** Folders that include folders, at most this deep. */
const FOLDER_DEPTH = 8

/** SQL for one term: a test on `k`/`l`, or a set of catalog ids, or both. */
interface Part {
  where?: SQL
  set?: SQL
  /** The set is a UNION or INTERSECT, which another must enclose. */
  compound?: boolean
  /** Evaluation order in a conjunction: lower first. */
  cost: number
}

const PLATFORM_PREFIX = /^([a-z][\w-]*):@/
const PLATFORM_OF = /^[a-z][\w-]*:/
const AT = /^@/
const DATE = /^\d{4}-/

/** `x:@alice`, `@alice` → `alice`. */
const handleOf = (value: string) =>
  value.replace(PLATFORM_OF, '').replace(AT, '')

// Not `isUUID`: its type guard would leave a string no type after it.
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

const TRUE: Part = { where: sql`1`, cost: 0 }
const FALSE: Part = { where: sql`0`, cost: 0 }

const whereOf = (part: Part): SQL => part.where ?? sql`k.id IN (${part.set!})`

/**
 * A set as a member of a compound SELECT: SQLite reads `a UNION b INTERSECT
 * c` from the left, and takes no parentheses around a member.
 */
const member = (part: Part): SQL =>
  part.compound ? sql`SELECT * FROM (${part.set!})` : part.set!

const COLUMNS = ['search_name', 'search_text', 'search_quoted', 'search_extra']

/** Catalog row `alias` holds the folded text in a search column. */
const holds = (alias: string, folded: string) =>
  sql`(${sql.join(
    COLUMNS.map((c) => sql`instr(${sql.raw(`${alias}.${c}`)}, ${folded}) > 0`),
    sql` OR `,
  )})`

/** The platforms `x:@alice` names (`x`), or all of them for `@alice`. */
function platformsOf(types: Types, value: string, at: number): string[] {
  const colon = PLATFORM_PREFIX.exec(value)
  if (!colon) return types.platforms
  if (!types.platforms.includes(colon[1]!) && !types.open)
    throw new QueryError(
      `Unknown platform ${colon[1]}; the archive has ${types.platforms.join(', ')}.`,
      at,
      'unknown_platform',
      { value: colon[1]!, platforms: types.platforms.join(', ') },
    )
  return [colon[1]!]
}

/**
 * The accounts a reference names, by identity: an account key, a saved
 * account's id, or a handle any catalogued item gives its author or itself
 * (so authors whose profile is not saved are found too, under any handle
 * they used). None when the archive has no such account: `from:` and the
 * agent API's `author` then select nothing. A platform the archive does not
 * have is a `QueryError`.
 */
export function resolveAccounts(
  db: Executor,
  types: Types,
  value: string,
  at = 0,
): Identity[] {
  if (UUID.test(value)) {
    const row = db.get<Identity>(sql`
      SELECT e.platform, e.kind, e.external_id AS external FROM catalog k
      JOIN library l ON l.collection_id = k.collection_id
      JOIN entities e ON e.id = k.root_entity_id
      WHERE k.collection_id = ${value.toLowerCase()}
        AND k.root_kind LIKE '%.profile'`)
    return row ? [row] : []
  }
  const key = parseAuthorKey(value)
  if (key) return [key]
  const handle = handleOf(value)
  const platforms = platformsOf(types, value, at)
  const line = `@${fold(handle)}`
  const named = sql`instr(char(10) || k.search_name || char(10),
    ${`\n${line}\n`}) > 0`
  // The name column of the trigram index holds `@handle` lines; shorter
  // ones are matched row by row.
  const indexed = [...line].length >= 3
  return db.all<Identity>(sql`
    SELECT DISTINCT e.platform, e.kind, e.external_id AS external
    FROM ${
      indexed
        ? sql`catalog_fts f CROSS JOIN catalog k ON k.id = f.rowid`
        : sql`catalog k`
    }
    JOIN entities e ON e.id = k.subject_entity_id
    WHERE ${indexed ? sql`catalog_fts MATCH ${`name : "${line.replaceAll('"', '""')}"`} AND ` : sql``}${named}
      AND e.kind LIKE '%.profile'
      AND e.platform IN (SELECT value FROM json_each(${list(platforms)}))`)
}

class Compiler {
  readonly ctes: SQL[] = []
  /** The folders the query's `folder:` terms read, with their queries. */
  readonly folders: { id: string; query: string }[] = []
  #searches = 0
  facets = false
  relative = false
  readonly o: CompileOptions
  readonly zone: string
  readonly now: number

  constructor(o: CompileOptions) {
    this.o = o
    this.zone = o.timeZone || 'UTC'
    this.now = o.now ?? Date.now()
  }

  // --- Looking things up ---------------------------------------------------

  platformsOf(value: string, at: number): string[] {
    return platformsOf(this.o.types, value, at)
  }

  accounts(value: string, at: number): Identity[] {
    return resolveAccounts(this.o.db, this.o.types, value, at)
  }

  tagId(name: string, at: number): string {
    const row = this.o.db
      .select({ id: tags.id })
      .from(tags)
      .where(
        isUUID(name) ? eq(tags.id, name.toLowerCase()) : eq(tags.name, name),
      )
      .get()
    if (!row)
      throw new QueryError(
        `Unknown tag ${name}. GET /agent/v1/tags lists them.`,
        at,
        'unknown_tag',
        { value: name },
      )
    return row.id
  }

  folderRow(ref: string, at: number) {
    const row = this.o.db
      .select({ id: folders.id, query: folders.query })
      .from(folders)
      .where(
        isUUID(ref) ? eq(folders.id, ref.toLowerCase()) : eq(folders.name, ref),
      )
      .get()
    if (!row)
      throw new QueryError(
        `No folder ${ref}. GET /agent/v1/folders lists them.`,
        at,
        'unknown_folder',
        { value: ref },
      )
    return row
  }

  /** Start of a date in the query's zone. */
  dayStart(date: string, days = 0): number {
    return Temporal.PlainDate.from(date)
      .add({ days })
      .toZonedDateTime(this.zone).epochMilliseconds
  }

  /** Where `30d` (today and the 29 days before) or `12h` starts. */
  spanStart(span: string): number {
    this.relative = true
    if (span.endsWith('h'))
      return this.now - Number(span.slice(0, -1)) * 3_600_000
    return savedSince(span, this.zone, this.now)!
  }

  typesOf(platform: string, at: number): string[] {
    if (this.o.types.open && !this.o.types.platforms.includes(platform))
      return [`${platform}.post`, `${platform}.profile`]
    if (!this.o.types.platforms.includes(platform))
      throw new QueryError(
        `Unknown platform ${platform}; the archive has ${this.o.types.platforms.join(', ')}.`,
        at,
        'unknown_platform',
        { value: platform, platforms: this.o.types.platforms.join(', ') },
      )
    return [...this.o.types.posts, ...this.o.types.accounts].filter((t) =>
      t.startsWith(`${platform}.`),
    )
  }

  // --- Terms ---------------------------------------------------------------

  /** Catalog rows a search finds, strictly: a set. */
  search(text: string, phrase: boolean): Part {
    const name = `${this.o.prefix ?? 'query'}_${this.#searches++}`
    const hits = searchHits(this.o.db, text, name, { fuzzy: false })
    if (!hits) return TRUE
    this.ctes.push(hits.ctes)
    if (!phrase || oneWord(text))
      return { set: sql`SELECT rowid FROM ${sql.raw(name)}`, cost: 3 }
    return {
      set: sql`SELECT p.rowid FROM ${sql.raw(name)} p
        CROSS JOIN catalog pk ON pk.id = p.rowid
        WHERE ${holds('pk', fold(text))}`,
      cost: 3,
    }
  }

  /** Catalog rows whose head quotes or reposts these roots. */
  pointing(kind: 'quoted' | 'reposted', targets: SQL): Part {
    // A repost is seen in any revision (a profile's timeline lists it); a
    // quote is the post's own content, its newest revision.
    const head = kind === 'quoted' ? sql` AND kp.revision_id = rv.id` : sql``
    return {
      set: sql`SELECT kp.id FROM (${targets}) target
        CROSS JOIN entity_versions v ON v.entity_id = target.entity
        CROSS JOIN revision_entities ref ON ref.entity_version_id = v.id
          AND ref.is_root = 0
        CROSS JOIN entity_relations edge ON edge.revision_id = ref.revision_id
          AND edge.target_key = ref.entity_key AND edge.kind = ${kind}
        CROSS JOIN revision_entities src ON src.revision_id = edge.revision_id
          AND src.entity_key = edge.source_key AND src.is_root = 1
        CROSS JOIN revisions rv ON rv.id = edge.revision_id
        CROSS JOIN catalog kp ON kp.collection_id = rv.collection_id${head}`,
      cost: 6,
    }
  }

  /**
   * Catalog rows these accounts reposted: the targets of a `reposted`
   * relation of the root of anything of theirs, in any revision (a
   * profile's timeline lists its reposts; a repost of theirs points at the
   * post it reposts). From the accounts' rows (`catalog_subject`), their
   * revisions (`revisions_head`), the root (`revision_entities_root`), its
   * relations (their key), to the reposted entity's rows (`catalog_root`).
   */
  repostedBy(accounts: SQL): Part {
    return {
      set: sql`SELECT kp.id FROM catalog own
        CROSS JOIN revisions rv ON rv.collection_id = own.collection_id
        CROSS JOIN revision_entities src ON src.revision_id = rv.id
          AND src.is_root = 1
        CROSS JOIN entity_relations edge ON edge.revision_id = rv.id
          AND edge.source_key = src.entity_key AND edge.kind = 'reposted'
        CROSS JOIN revision_entities target ON target.revision_id = rv.id
          AND target.entity_key = edge.target_key
        CROSS JOIN entity_versions tv ON tv.id = target.entity_version_id
        CROSS JOIN catalog kp ON kp.root_entity_id = tv.entity_id
        WHERE own.subject_entity_id IN ${accounts}`,
      cost: 6,
    }
  }

  /** The root entities of a post id, or of every post by an account. */
  roots(value: string, at: number): SQL {
    if (UUID.test(value))
      return sql`SELECT root_entity_id AS entity FROM catalog
        WHERE collection_id = ${value}`
    const authors = this.accounts(value, at)
    return sql`SELECT k2.root_entity_id AS entity FROM catalog k2
      WHERE k2.author_entity_id IN ${this.entityIds(authors)}`
  }

  entityIds(of: Identity[]): SQL {
    return sql`(SELECT au.id FROM json_each(${list(of.map((a) => [a.platform, a.kind, a.external]))}) wanted
      JOIN entities au ON au.platform = wanted.value ->> 0
        AND au.kind = wanted.value ->> 1 AND au.external_id = wanted.value ->> 2)`
  }

  leaf(leaf: Leaf): Part {
    const at = leaf.start
    switch (leaf.type) {
      case 'word':
        return this.search(leaf.value, false)
      case 'phrase':
        return this.search(leaf.value, true)
      case 'hashtag':
        this.facets = true
        return {
          set: sql`SELECT catalog_id FROM post_hashtags WHERE value = ${leaf.value}`,
          cost: 1,
        }
    }
    const value = leaf.value
    switch (leaf.key) {
      case 'mentions': {
        this.facets = true
        const handle = handleOf(value)
        const values = this.platformsOf(value, at).map((p) => `${p}:${handle}`)
        return {
          set: sql`SELECT catalog_id FROM post_mentions
            WHERE value IN (${sql.join(
              values.map((v) => sql.param(v)),
              sql`, `,
            )})`,
          cost: 1,
        }
      }
      case 'domain':
        this.facets = true
        return {
          set: sql`SELECT catalog_id FROM post_domains WHERE value = ${value}`,
          cost: 1,
        }
      case 'from': {
        const authors = this.accounts(value, at)
        if (!authors.length) return FALSE
        return {
          set: sql`SELECT id FROM catalog WHERE author_entity_id IN ${this.entityIds(authors)}`,
          cost: 2,
        }
      }
      case 'tag':
        return {
          set: sql`SELECT t.id FROM catalog t
            WHERE t.collection_id IN ${taggedSQL([this.tagId(value, at)])}`,
          cost: 2,
        }
      case 'rel': {
        const { set, min, accounts } = this.follows(value, at)
        return {
          set: sql`SELECT id FROM catalog
            WHERE subject_entity_id IN ${followSetSQL(accounts, set, min)}`,
          cost: 2,
        }
      }
      case 'protected': {
        // As the list's visibility: the account as it is now.
        return {
          where: sql`(SELECT s.subject_protected FROM catalog s
            WHERE s.subject_entity_id = k.subject_entity_id
            ORDER BY s.revision_at DESC, s.revision_id DESC LIMIT 1) = ${value === 'yes' ? 1 : 0}`,
          cost: 5,
        }
      }
      case 'related':
        return {
          where: sql`k.collection_id IN (SELECT r.collection_id FROM (WITH ${relatedEdgesSQL(sql`SELECT ${value} AS id`)}
            SELECT collection_id FROM related_edges
            WHERE collection_id <> requested_id) r)`,
          cost: 7,
        }
      case 'state':
        return {
          where: sql`k.collection_id IN (SELECT id FROM collections
            WHERE source_state = ${value})`,
          cost: 2,
        }
      case 'quotes':
        return this.pointing('quoted', this.roots(value, at))
      case 'reposts':
        return this.pointing('reposted', this.roots(value, at))
      case 'reposted-by': {
        const accounts = this.accounts(value, at)
        if (!accounts.length) return FALSE
        return this.repostedBy(this.entityIds(accounts))
      }
      case 'folder':
        // Replaced by what the folder says before any SQL is made.
        throw new Error('folder: was not expanded')
      case 'has':
        if (value === 'link') {
          this.facets = true
          return {
            where: sql`EXISTS (SELECT 1 FROM post_domains d WHERE d.catalog_id = k.id)`,
            cost: 4,
          }
        }
        return {
          where:
            value === 'media'
              ? sql`k.has_media`
              : mediaSQL([value === 'image' ? 'image' : 'video']),
          cost: 4,
        }
      case 'lang':
        this.facets = true
        // A language without a script takes its scripts too: `zh` is
        // `zh-Hans`, `zh-Hant` and Chinese of no telling script.
        return {
          where: value.includes('-')
            ? sql`k.lang = ${value}`
            : sql`(k.lang = ${value} OR k.lang GLOB ${`${value}-*`})`,
          cost: 4,
        }
      case 'platform':
        return { where: rootTypeSQL(this.typesOf(value, at)), cost: 4 }
      case 'type':
        return {
          where: rootTypeSQL(
            value === 'profile' ? this.o.types.accounts : this.o.types.posts,
          ),
          cost: 4,
        }
      case 'sensitive':
        return {
          where: sql`k.has_sensitive = ${value === 'yes' ? 1 : 0}`,
          cost: 4,
        }
      case 'is':
        return {
          where: sql`${postTypeSQL(false)} = ${value === 'original' ? 'post' : value}`,
          cost: 6,
        }
      case 'since':
        return { where: sql`k.published_at >= ${this.moment(value)}`, cost: 4 }
      case 'until':
        return { where: sql`k.published_at < ${this.moment(value)}`, cost: 4 }
      case 'within':
        return {
          where: sql`k.published_at >= ${this.spanStart(value)}`,
          cost: 4,
        }
      case 'saved-since':
        return { where: sql`l.created_at >= ${this.moment(value)}`, cost: 4 }
      case 'saved-until':
        return { where: sql`l.created_at < ${this.moment(value)}`, cost: 4 }
      case 'saved':
        return {
          where: DATE.test(value)
            ? sql`(l.created_at >= ${this.dayStart(value)}
                AND l.created_at < ${this.dayStart(value, 1)})`
            : sql`l.created_at >= ${this.spanStart(value)}`,
          cost: 4,
        }
    }
  }

  /** `following:2:@a,@b,@c`: the set, the threshold and the accounts. */
  follows(value: string, at: number) {
    const [set, ...rest] = value.split(':')
    let min: number | undefined
    if (DIGITS.test(rest[0] ?? '') && rest.length > 1)
      min = Number(rest.shift())
    const accounts = rest
      .join(':')
      .split(',')
      .map((ref) => this.perspective(ref, at))
    return {
      set: set as FollowSet,
      min: min ?? Math.min(2, accounts.length),
      accounts,
    }
  }

  /** A date's start in the query's zone, or a moment as given. */
  moment(value: string): number {
    return value.includes('T') ? Date.parse(value) : this.dayStart(value)
  }

  /**
   * `folder:` replaced by what the folder's query says (a folder whose
   * query is empty selects everything), folders inside folders too, and
   * AND and OR flattened again around them. The folders read are kept:
   * what they say is part of what the query is.
   */
  expand(node: QueryNode, seen: string[] = []): Expanded {
    const span = { start: node.start, end: node.end }
    switch (node.type) {
      case 'and':
      case 'or': {
        const items: QueryNode[] = []
        for (const item of node.items) {
          const expanded = this.expand(item, seen)
          if (isConstant(expanded)) {
            // AND with everything, OR with nothing: no difference.
            if ((expanded.type === 'all') === (node.type === 'and')) continue
            return { type: expanded.type, ...span }
          }
          if (expanded.type === node.type) items.push(...expanded.items)
          else items.push(expanded)
        }
        if (!items.length)
          return { type: node.type === 'and' ? 'all' : 'none', ...span }
        return items.length === 1
          ? items[0]!
          : { type: node.type, items, ...span }
      }
      case 'not': {
        const item = this.expand(node.item, seen)
        if (isConstant(item))
          return { type: item.type === 'all' ? 'none' : 'all', ...span }
        return item.type === 'not' ? item.item : { type: 'not', item, ...span }
      }
      case 'atom': {
        if (node.key !== 'folder') return node
        const folder = this.folderRow(node.value, node.start)
        if (seen.includes(folder.id) || seen.length >= FOLDER_DEPTH)
          throw new QueryError(
            `Folders include each other: ${node.value} again.`,
            node.start,
            'folder_cycle',
            { value: node.value },
          )
        this.folders.push({ id: folder.id, query: folder.query })
        const inner = parseQuery(folder.query, OWNER_LIMITS)
        if (!inner) return { type: 'all', ...span }
        // Where a problem inside it is, is this term.
        const placed = respan(inner, span)
        return this.expand(placed, [...seen, folder.id])
      }
      default:
        return node
    }
  }

  /** A perspective of `rel:`, as the list's follow filter takes one. */
  perspective(value: string, at: number): Identity {
    const found = this.accounts(value, at)
    if (found.length !== 1)
      throw new QueryError(
        found.length
          ? `rel: ${value} names ${found.length} accounts; give one as x:@handle or by its key.`
          : `rel: no account ${value} is in the archive.`,
        at,
        found.length ? 'ambiguous_account' : 'unknown_account',
        { value, count: found.length },
      )
    return found[0]!
  }

  node(node: Expanded): Part {
    if (isConstant(node)) return node.type === 'all' ? TRUE : FALSE
    switch (node.type) {
      case 'and': {
        const parts = node.items
          .map((item) => this.node(item))
          .toSorted((a, b) => a.cost - b.cost)
        return {
          where: sql`(${sql.join(parts.map(whereOf), sql` AND `)})`,
          ...(parts.every((p) => p.set)
            ? {
                set: sql.join(parts.map(member), sql` INTERSECT `),
                compound: true,
              }
            : {}),
          cost: Math.min(...parts.map((p) => p.cost)),
        }
      }
      case 'or': {
        const parts = node.items.map((item) => this.node(item))
        // Sets from indexes: their union drives; a test anywhere makes it
        // a test.
        if (parts.every((p) => p.set))
          return {
            set: sql.join(parts.map(member), sql` UNION `),
            compound: true,
            cost: Math.max(...parts.map((p) => p.cost)),
          }
        return {
          where: sql`(${sql.join(parts.map(whereOf), sql` OR `)})`,
          cost: Math.max(...parts.map((p) => p.cost)),
        }
      }
      case 'not': {
        const part = this.node(node.item)
        return {
          where: part.set
            ? sql`k.id NOT IN (${part.set})`
            : sql`NOT coalesce(${part.where!}, 0)`,
          cost: part.cost + 1,
        }
      }
      default:
        return this.leaf(node)
    }
  }
}

/** A tree with every span set to one (a folder's, where it was named). */
function respan(
  node: QueryNode,
  span: { start: number; end: number },
): QueryNode {
  switch (node.type) {
    case 'and':
    case 'or':
      return { ...node, ...span, items: node.items.map((i) => respan(i, span)) }
    case 'not':
      return { ...node, ...span, item: respan(node.item, span) }
    default:
      return { ...node, ...span }
  }
}

/** The top level's terms: an AND's, or the one. */
const conjuncts = (node: Expanded): Expanded[] =>
  node.type === 'and' ? node.items : [node]

const atom = (node: Expanded, key?: string) =>
  node.type === 'atom' && (!key || node.key === key) ? node : undefined

/** `has:image`, `has:video` and `-has:media`, as the list's media types. */
function mediaKind(node: Expanded): string | undefined {
  const has = atom(node, 'has') as Leaf | undefined
  if (has && (has.value === 'image' || has.value === 'video')) return has.value
  if (
    node.type === 'not' &&
    (atom(node.item, 'has') as Leaf)?.value === 'media'
  )
    return 'text'
  return undefined
}

/**
 * Compile a query: its canonical form, the filter with what it says in the
 * filter's own terms, and SQL for the rest. Throws `QueryError`.
 */
export function compileQuery(
  text: string,
  o: CompileOptions,
): CompiledQuery | undefined {
  const node = parseQuery(text, o.limits ?? LIMITS)
  if (!node) return undefined
  const parsed = printQuery(node)
  if (onlyNegative(node) && !o.scoped)
    throw new QueryError(
      'A query of only exclusions (-) needs something to start from: since:, until:, within:, saved:, from:, folder: or tag:, or the author, tag or folder parameters.',
      node.start,
      'only_exclusions',
    )
  const compiled = compileNode(node, parsed, o, true)
  // Said in the filter's terms, some combinations are ones the filter
  // refuses (a tag both wanted and not, saved after it was saved until):
  // then everything but the keyword search is said in SQL.
  try {
    checkFilter(compiled.filter)
    return compiled
  } catch {
    return compileNode(node, parsed, o, false)
  }
}

function compileNode(
  node: QueryNode,
  parsed: string,
  o: CompileOptions,
  lowering: boolean,
): CompiledQuery {
  const c = new Compiler(o)
  const filter: CollectionFilter = { ...o.filter }
  const rest: Expanded[] = []
  const words: string[] = []
  const phrases: string[] = []
  const tagsWanted: string[] = []
  const tagsExcluded: string[] = []
  const types = () =>
    filter.entityType
      ? filter.entityType.split(',')
      : [...o.types.posts, ...o.types.accounts]
  /** Narrow the filter's types to these; false when none would be left. */
  const narrowTypes = (wanted: string[]) => {
    // Nothing narrowed yet: these.
    if (!filter.entityType) {
      filter.entityType = [...new Set(wanted)].toSorted().join(',')
      return true
    }
    const both = types()
      .filter((t) => wanted.includes(t))
      .toSorted()
    // None left would read as no condition at all.
    if (!both.length) return false
    filter.entityType = both.join(',')
    return true
  }
  const lower = (item: Expanded): boolean => {
    if (item.type === 'all') return true
    if (item.type === 'none') return false
    if (!lowering && item.type !== 'word' && item.type !== 'phrase')
      return false
    if (item.type === 'word') {
      words.push(item.value)
      return true
    }
    if (item.type === 'phrase') {
      words.push(item.value)
      if (!oneWord(item.value)) phrases.push(item.value)
      return true
    }
    if (item.type === 'not') {
      const tag = atom(item.item, 'tag') as Leaf | undefined
      if (tag && !filter.notTag?.length) {
        tagsExcluded.push(c.tagId(tag.value, tag.start))
        return true
      }
      if (mediaKind(item) && !filter.mediaType) {
        filter.mediaType = 'text'
        return true
      }
      return false
    }
    if (item.type === 'or') {
      // Alternatives the filter takes as a list: any of them.
      const all = item.items.every((i) => atom(i, 'from'))
      if (all && !filter.authors?.length) {
        const found = item.items.flatMap((i) =>
          c.accounts((i as Leaf).value, i.start),
        )
        if (!found.length) return false
        filter.authors = [...new Set(found.map((a) => authorKey(a)))]
        return true
      }
      if (
        item.items.every((i) => atom(i, 'tag')) &&
        !filter.tag &&
        !tagsWanted.length
      ) {
        filter.tag = item.items
          .map((i) => c.tagId((i as Leaf).value, i.start))
          .join(',')
        return true
      }
      const media = item.items.map((i) => mediaKind(i))
      if (
        media.every(Boolean) &&
        new Set(media).size === media.length &&
        !filter.mediaType
      ) {
        filter.mediaType = (media as string[]).toSorted().join(',')
        return true
      }
      if (item.items.every((i) => atom(i, 'platform')))
        return narrowTypes(
          item.items.flatMap((i) => c.typesOf((i as Leaf).value, i.start)),
        )
      return false
    }
    if (item.type !== 'atom') return false
    const v = item.value
    switch (item.key) {
      case 'from': {
        if (filter.authors?.length) return false
        const found = c.accounts(v, item.start)
        if (!found.length) return false
        filter.authors = found.map((a) => authorKey(a))
        return true
      }
      case 'tag':
        if (filter.tag) return false
        tagsWanted.push(c.tagId(v, item.start))
        return true
      case 'rel': {
        if (filter.relOf?.length) return false
        const { set, min, accounts } = c.follows(v, item.start)
        filter.relOf = accounts.map((a) => authorKey(a))
        filter.rel = set
        if (min !== Math.min(2, accounts.length)) filter.relMin = String(min)
        return true
      }
      case 'platform':
        return narrowTypes(c.typesOf(v, item.start))
      case 'type':
        return narrowTypes(v === 'profile' ? o.types.accounts : o.types.posts)
      case 'has':
        if (filter.mediaType || (v !== 'image' && v !== 'video')) return false
        filter.mediaType = v
        return true
      case 'protected':
        if (filter.visibility) return false
        filter.visibility = v === 'yes' ? 'private' : 'public'
        return true
      case 'related':
        if (filter.relatedTo) return false
        filter.relatedTo = v
        return true
      case 'sensitive':
        if (filter.sensitive) return false
        filter.sensitive = v === 'yes' ? 'contains' : 'not_contains'
        return true
      case 'state':
        if (filter.sourceState) return false
        filter.sourceState = v
        return true
      case 'is':
        if (filter.postType) return false
        filter.postType = v === 'original' ? 'post' : v
        return true
      case 'saved-since':
        if (filter.savedFrom || filter.savedWithin) return false
        filter.savedFrom = new Date(c.moment(v)).toISOString()
        return true
      case 'saved-until':
        if (filter.savedBefore || filter.savedWithin) return false
        filter.savedBefore = new Date(c.moment(v)).toISOString()
        return true
      case 'saved':
        if (filter.savedFrom || filter.savedBefore || filter.savedWithin)
          return false
        if (DATE.test(v)) {
          filter.savedFrom = new Date(c.dayStart(v)).toISOString()
          filter.savedBefore = new Date(c.dayStart(v, 1)).toISOString()
          return true
        }
        if (!v.endsWith('d')) return false
        filter.savedWithin = v
        if (o.timeZone) filter.timeZone = o.timeZone
        return true
      default:
        return false
    }
  }
  const expanded = c.expand(node, o.within ? [o.within] : [])
  for (const item of conjuncts(expanded)) if (!lower(item)) rest.push(item)
  if (tagsWanted.length) {
    filter.tag = tagsWanted.join(',')
    if (tagsWanted.length > 1) filter.tagMode = 'all'
  }
  if (tagsExcluded.length) filter.notTag = tagsExcluded.join(',')
  if (words.length) filter.q = words.join(' ')
  const parts = rest.map((item) => c.node(item))
  for (const phrase of phrases)
    parts.push({ where: holds('k', fold(phrase)), cost: 5 })
  // Only what the filter cannot say makes SQL of its own: a query the
  // filter says all of runs as the filter does.
  if (!parts.length) return { node, parsed, filter }
  return {
    node,
    parsed,
    filter,
    extra: {
      ctes: c.ctes,
      where: sql.join(
        parts.toSorted((a, b) => a.cost - b.cost).map(whereOf),
        sql` AND `,
      ),
      // What the folders it names say is part of what it is.
      key: c.folders.length
        ? `${parsed}\n${JSON.stringify(c.folders)}`
        : parsed,
      ...(c.relative ? { volatile: true } : {}),
    },
  }
}
