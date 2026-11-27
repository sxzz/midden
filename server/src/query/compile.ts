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
import { facetsComplete } from '#library/facets.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import { followSetSQL, type FollowSet } from '#library/follows.ts'
import {
  authorKey,
  checkFilter,
  mediaSQL,
  parseAuthorKey,
  postTypeSQL,
  rootTypeSQL,
  savedSince,
  taggedSQL,
  wholeSelection,
  type CollectionFilter,
  type Identity,
  type QueryExtra,
} from '#library/list.ts'
import { isUUID } from '#library/read.ts'
import { fold } from '#library/search-text.ts'
import { searchHits } from '#library/search.ts'
import { list } from '#library/views.ts'
import {
  onlyNegative,
  parseQuery,
  QueryError,
  type Leaf,
  type QueryNode,
} from './ast.ts'
import { printQuery } from './print.ts'
import type { Database } from '#db/client.ts'

/** The entity types of the archive's platforms. */
export interface Types {
  platforms: string[]
  posts: string[]
  accounts: string[]
}

export interface CompileOptions {
  db: Database
  types: Types
  /** Posts, accounts, or both (aggregation). */
  kind: 'posts' | 'accounts' | 'all'
  /** The filter the request's other parameters give; the query adds to it. */
  filter: CollectionFilter
  /** The request starts from a folder already (`folder=`). */
  folder?: boolean
  /**
   * A lone `folder:` may be where the list starts, the rest narrowing it:
   * not when the other parameters name what a narrowing cannot (tags,
   * follows, related items).
   */
  canScope?: boolean
  /** The other parameters scope it (dates, author, folder, tag, follows). */
  scoped?: boolean
  /** IANA zone of the query's dates; UTC by default. */
  timeZone?: string
  now?: number
}

/** A folder a query starts from: `folder:` alone at its top level. */
export interface QueryFolder {
  id: string
  name: string
  filter: CollectionFilter
}

export interface CompiledQuery {
  node: QueryNode
  /** The canonical query. */
  parsed: string
  /** The request's filter with what the query could say in its terms. */
  filter: CollectionFilter
  folder?: QueryFolder
  extra?: QueryExtra
}

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

class Compiler {
  readonly ctes: SQL[] = []
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
    const colon = PLATFORM_PREFIX.exec(value)
    if (!colon) return this.o.types.platforms
    if (!this.o.types.platforms.includes(colon[1]!))
      throw new QueryError(
        `Unknown platform ${colon[1]}; the archive has ${this.o.types.platforms.join(', ')}.`,
        at,
      )
    return [colon[1]!]
  }

  /**
   * The accounts a reference names, by identity: an account key, a saved
   * account's id, or a handle any catalogued item gives its author or
   * itself (so authors whose profile is not saved are found too, under
   * any handle they used).
   */
  accounts(value: string, at: number): Identity[] {
    if (UUID.test(value)) {
      const row = this.o.db.get<Identity>(sql`
        SELECT e.platform, e.kind, e.external_id AS external FROM catalog k
        JOIN library l ON l.collection_id = k.collection_id
        JOIN entities e ON e.id = k.root_entity_id
        WHERE k.collection_id = ${value} AND k.root_kind LIKE '%.profile'`)
      if (!row)
        throw new QueryError(`No saved account has the id ${value}.`, at)
      return [row]
    }
    const key = parseAuthorKey(value)
    if (key) return [key]
    const handle = handleOf(value)
    const platforms = this.platformsOf(value, at)
    const line = `@${fold(handle)}`
    const named = sql`instr(char(10) || k.search_name || char(10),
      ${`\n${line}\n`}) > 0`
    // The name column of the trigram index holds `@handle` lines; shorter
    // ones are matched row by row.
    const rows = this.o.db.all<Identity>(sql`
      SELECT DISTINCT e.platform, e.kind, e.external_id AS external
      FROM ${
        [...line].length >= 3
          ? sql`catalog_fts f CROSS JOIN catalog k ON k.id = f.rowid`
          : sql`catalog k`
      }
      JOIN entities e ON e.id = k.subject_entity_id
      WHERE ${[...line].length >= 3 ? sql`catalog_fts MATCH ${`name : "${line.replaceAll('"', '""')}"`} AND ` : sql``}${named}
        AND e.kind LIKE '%.profile'
        AND e.platform IN (SELECT value FROM json_each(${list(platforms)}))`)
    return rows
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
      )
    return row.id
  }

  folder(ref: string, at: number): QueryFolder {
    const row = this.o.db
      .select()
      .from(folders)
      .where(
        isUUID(ref) ? eq(folders.id, ref.toLowerCase()) : eq(folders.name, ref),
      )
      .get()
    if (!row)
      throw new QueryError(
        `No folder ${ref}. GET /agent/v1/folders lists them.`,
        at,
      )
    return {
      id: row.id,
      name: row.name,
      filter: parseFilterQuery(row.filter).filter,
    }
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
    if (!this.o.types.platforms.includes(platform))
      throw new QueryError(
        `Unknown platform ${platform}; the archive has ${this.o.types.platforms.join(', ')}.`,
        at,
      )
    return [...this.o.types.posts, ...this.o.types.accounts].filter((t) =>
      t.startsWith(`${platform}.`),
    )
  }

  // --- Terms ---------------------------------------------------------------

  /** Catalog rows a search finds, strictly: a set. */
  search(text: string, phrase: boolean): Part {
    const name = `query_${this.#searches++}`
    const hits = searchHits(this.o.db, text, name, { fuzzy: false })
    if (!hits) return TRUE
    this.ctes.push(hits.ctes)
    if (!phrase)
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
        const [set, ...rest] = value.split(':')
        const of = this.perspective(rest.join(':'), at)
        return {
          set: sql`SELECT id FROM catalog
            WHERE subject_entity_id IN ${followSetSQL([of], set as FollowSet)}`,
          cost: 2,
        }
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
      case 'folder': {
        const folder = this.folder(value, at)
        const inner = wholeSelection(this.o.db, folder.filter)
        return {
          where: sql`k.collection_id IN (${inner.ctes}
            SELECT k.collection_id FROM ${sql.raw(inner.source)}
            WHERE ${inner.where})`,
          cost: 7,
        }
      }
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
        return { where: sql`k.lang = ${value}`, cost: 4 }
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
        return {
          where: sql`k.published_at >= ${this.dayStart(value)}`,
          cost: 4,
        }
      case 'until':
        return { where: sql`k.published_at < ${this.dayStart(value)}`, cost: 4 }
      case 'within':
        return {
          where: sql`k.published_at >= ${this.spanStart(value)}`,
          cost: 4,
        }
      case 'saved-since':
        return { where: sql`l.created_at >= ${this.dayStart(value)}`, cost: 4 }
      case 'saved-until':
        return { where: sql`l.created_at < ${this.dayStart(value)}`, cost: 4 }
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

  /** A perspective of `rel:`, as the list's follow filter takes one. */
  perspective(value: string, at: number): Identity {
    const found = this.accounts(value, at)
    if (found.length !== 1)
      throw new QueryError(
        found.length
          ? `rel: ${value} names ${found.length} accounts; give one as x:@handle or by its key.`
          : `rel: no account ${value} is in the archive.`,
        at,
      )
    return found[0]!
  }

  node(node: QueryNode): Part {
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

/** The top level's terms: an AND's, or the one. */
const conjuncts = (node: QueryNode) =>
  node.type === 'and' ? node.items : [node]

const atom = (node: QueryNode, key?: string) =>
  node.type === 'atom' && (!key || node.key === key) ? node : undefined

/**
 * Compile a query: its canonical form, the filter with what it says in the
 * filter's own terms, and SQL for the rest. Throws `QueryError`.
 */
export function compileQuery(
  text: string,
  o: CompileOptions,
): CompiledQuery | undefined {
  const node = parseQuery(text)
  if (!node) return undefined
  const parsed = printQuery(node)
  if (onlyNegative(node) && !o.scoped)
    throw new QueryError(
      'A query of only exclusions (-) needs something to start from: since:, until:, within:, saved:, from:, folder: or tag:, or the author, tag or folder parameters.',
      node.start,
    )
  const compiled = compileNode(node, parsed, o, true)
  // Said in the filter's terms, some combinations are ones the filter
  // refuses (a tag both wanted and not, saved after it was saved until):
  // then everything but the keyword search is said in SQL.
  try {
    checkFilter(compiled.folder ? compiled.folder.filter : compiled.filter)
    if (compiled.folder) checkFilter(compiled.filter)
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
  const rest: QueryNode[] = []
  const words: string[] = []
  const phrases: string[] = []
  let folder: QueryFolder | undefined
  const items = conjuncts(node)
  // A lone `folder:` at the top level is where the list starts, as
  // `folder=` is; then the rest may only narrow it.
  const folders = items.filter((item) => atom(item, 'folder'))
  if (lowering && !o.folder && o.canScope !== false && folders.length === 1) {
    const f = folders[0] as Leaf
    folder = c.folder(f.value, f.start)
  }
  const scoped = !!(o.folder || folder)
  const tagsWanted: string[] = []
  const tagsExcluded: string[] = []
  const lower = (item: QueryNode): boolean => {
    if (!lowering && item.type !== 'word' && item.type !== 'phrase')
      return false
    if (item.type === 'word') {
      words.push(item.value)
      return true
    }
    if (item.type === 'phrase') {
      words.push(item.value)
      phrases.push(item.value)
      return true
    }
    if (item.type === 'not') {
      const tag = atom(item.item, 'tag') as Leaf | undefined
      if (tag && !scoped && !filter.notTag?.length) {
        tagsExcluded.push(c.tagId(tag.value, tag.start))
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
        !scoped &&
        !filter.tag &&
        !tagsWanted.length
      ) {
        filter.tag = item.items
          .map((i) => c.tagId((i as Leaf).value, i.start))
          .join(',')
        return true
      }
      return false
    }
    if (item.type !== 'atom') return false
    const v = item.value
    switch (item.key) {
      case 'folder':
        return !!folder && v === (folders[0] as Leaf).value
      case 'from': {
        if (filter.authors?.length) return false
        const found = c.accounts(v, item.start)
        if (!found.length) return false
        filter.authors = found.map((a) => authorKey(a))
        return true
      }
      case 'tag':
        if (scoped || filter.tag) return false
        tagsWanted.push(c.tagId(v, item.start))
        return true
      case 'rel': {
        if (scoped || filter.relOf?.length) return false
        const [set, ...ref] = v.split(':')
        filter.relOf = [authorKey(c.perspective(ref.join(':'), item.start))]
        filter.rel = set
        return true
      }
      case 'platform':
      case 'type': {
        const types =
          item.key === 'platform'
            ? c.typesOf(v, item.start)
            : v === 'profile'
              ? o.types.accounts
              : o.types.posts
        const current = filter.entityType
          ? filter.entityType.split(',')
          : [...o.types.posts, ...o.types.accounts]
        const both = current.filter((t) => types.includes(t)).toSorted()
        // None left would read as no condition at all.
        if (!both.length) return false
        filter.entityType = both.join(',')
        return true
      }
      case 'has':
        if (filter.mediaType || (v !== 'image' && v !== 'video')) return false
        filter.mediaType = v
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
        filter.savedFrom = new Date(c.dayStart(v)).toISOString()
        return true
      case 'saved-until':
        if (filter.savedBefore || filter.savedWithin) return false
        filter.savedBefore = new Date(c.dayStart(v)).toISOString()
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
  for (const item of items) if (!lower(item)) rest.push(item)
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
  if (!parts.length)
    return { node, parsed, filter, ...(folder ? { folder } : {}) }
  const volatile = c.relative || (c.facets && !facetsComplete(o.db))
  return {
    node,
    parsed,
    filter,
    ...(folder ? { folder } : {}),
    extra: {
      ctes: c.ctes,
      where: sql.join(
        parts.toSorted((a, b) => a.cost - b.cost).map(whereOf),
        sql` AND `,
      ),
      key: parsed,
      ...(volatile ? { volatile } : {}),
    },
  }
}
