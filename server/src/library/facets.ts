// What the query language and aggregation read besides the catalog's own
// columns: per catalogued item, the hashtags, mentioned handles and link
// domains of its newest revision (`post_hashtags`, `post_mentions`,
// `post_domains`) and the language of its text (`catalog.lang`).
//
// Neither platform's stored data names hashtags, links or a language, so
// they are read from the item's own text: a post's text, an account's bio
// (and its website). Mentions are what the platforms recorded as `mentions`
// relations of the root (X from facets and the text, Instagram from the
// caption).
//
// Writes: a row's values follow its revision, so `catalogCollections` asks
// for them again only for rows whose revision changed (or that are new), and
// only values that differ are written. Capturing an item again unchanged
// keeps its revision and writes nothing here. Rows catalogued before these
// tables are filled by maintenance (`backfillFacets`), a batch at a time
// while the worker is idle.
//
// `library_version`: none of this moves it. What a folder selects cannot
// depend on these values yet, since folders store list filters, not
// queries. When they can (folders storing queries), nothing new is needed
// for captures: values change only with `catalog.revision_id`, whose
// trigger already moves the version in the same transaction. Only the
// backfill writes them on its own, so it would move the version once per
// batch that changed anything.
import { sql } from 'drizzle-orm'
import { readSetting } from '#settings.ts'
import { list } from './views.ts'
import type { Database, Executor } from '#db/client.ts'

/** The tables, by what they hold. */
export const FACET_TABLES = {
  hashtags: 'post_hashtags',
  mentions: 'post_mentions',
  domains: 'post_domains',
} as const

export type FacetKind = keyof typeof FACET_TABLES

export interface Facets {
  lang: string | null
  hashtags: string[]
  mentions: string[]
  domains: string[]
}

// --- Values ---------------------------------------------------------------

/** At most this many characters of a value are kept. */
const MAX_VALUE = 100

/** A hashtag as stored and asked for: compatibility forms plain, lower case. */
export const foldHashtag = (tag: string) =>
  tag.normalize('NFKC').toLowerCase().slice(0, MAX_VALUE)

const AT = /^@/

/** A handle as stored: lower case, without `@`, with its platform. */
export const mentionValue = (platform: string, handle: string) =>
  `${platform}:${handle.replace(AT, '').toLowerCase()}`

const URL_PATTERN =
  /https?:\/\/[^\s<>"'`()（）「」『』【】〈〉《》、。，！？…]+/giu
const TRAILING = /[.,;:!?'"\]}>*]+$/u

/** The links in a text, as written. */
export function linksOf(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map(([url]) =>
    url.replace(TRAILING, ''),
  )
}

// Hashtag characters as X counts them: letters, marks, digits, `_`, and the
// katakana middle dot and long vowel mark; not all digits. Not inside a word
// or right after `&` (`&#39;`), and links are removed first (`/#anchor`).
const HASHTAG = /(?<![\p{L}\p{M}\p{Nd}_&/])[#＃]([\p{L}\p{M}\p{Nd}_・]+)/gu
const HAS_LETTER = /[\p{L}\p{M}]/u

/** The hashtags of a text, folded, each once. */
export function hashtagsOf(text: string): string[] {
  const plain = text.replaceAll(URL_PATTERN, ' ')
  const tags = new Set<string>()
  for (const [, tag] of plain.matchAll(HASHTAG))
    if (HAS_LETTER.test(tag!)) tags.add(foldHashtag(tag!))
  return [...tags]
}

/**
 * Second-level suffixes under which a name is registered one level deeper
 * (`example.co.uk`), and hosts that give each user a subdomain of their
 * own (`alice.github.io`): a short list of the common ones, after the
 * Public Suffix List, rather than all of it.
 */
const SUFFIXES = new Set(
  [
    'ac.jp ad.jp co.jp ed.jp go.jp gr.jp lg.jp ne.jp or.jp',
    'ac.uk co.uk gov.uk ltd.uk me.uk net.uk org.uk plc.uk',
    'com.cn edu.cn gov.cn net.cn org.cn com.hk edu.hk gov.hk net.hk org.hk',
    'com.tw edu.tw gov.tw idv.tw net.tw org.tw com.mo',
    'ac.kr co.kr go.kr ne.kr or.kr com.sg edu.sg gov.sg',
    'com.au edu.au gov.au net.au org.au co.nz net.nz org.nz',
    'com.br net.br org.br gov.br com.ar com.mx com.co com.pe',
    'co.in net.in org.in ac.in co.id or.id ac.id web.id co.th ac.th in.th',
    'com.my com.ph com.vn com.tr com.sa com.eg com.pk co.il org.il co.za',
    'github.io gitlab.io pages.dev workers.dev netlify.app vercel.app',
    'web.app firebaseapp.com herokuapp.com glitch.me neocities.org',
    'blogspot.com wordpress.com tumblr.com substack.com notion.site',
    'hatenablog.com hatenablog.jp hateblo.jp hatenadiary.com hatenadiary.jp',
    'fanbox.cc booth.pm itch.io carrd.co wixsite.com',
  ].flatMap((line) => line.split(' ')),
)

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const FINAL_DOT = /\.$/
const WWW = /^www\./
const SCHEME = /^[a-z][\w+.-]*:/i

/**
 * The registrable domain of a host, lower case, without `www.`:
 * `music.youtube.com` → `youtube.com`, `news.bbc.co.uk` → `bbc.co.uk`,
 * `alice.github.io` stays. Addresses stay as they are.
 */
export function registrableDomain(host: string): string {
  const lower = host.toLowerCase().replace(FINAL_DOT, '')
  if (IPV4.test(lower) || lower.includes(':')) return lower
  const labels = lower.replace(WWW, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const keep = SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** Link shorteners whose domain says nothing of where a link goes. */
const SHORTENERS = new Set(['t.co'])

/** The registrable domain of a link or a bare host; undefined if none. */
export function domainOf(raw: string): string | undefined {
  const scheme = SCHEME.test(raw)
  try {
    const url = new URL(scheme ? raw : `http://${raw}`)
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol))
      return undefined
    const domain = registrableDomain(url.hostname)
    return domain && !SHORTENERS.has(domain) ? domain : undefined
  } catch {
    return undefined
  }
}

/** The domains a text's links (and any further addresses) point at. */
export function domainsOf(text: string, also: string[] = []): string[] {
  const domains = new Set<string>()
  for (const link of [...linksOf(text), ...also]) {
    const domain = domainOf(link)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

// --- Language -------------------------------------------------------------

/** Words common in one language and rare elsewhere, by language. */
const STOPWORDS: Record<string, string> = {
  en: 'the and is are was were to of for you this that it with on my be have not what just your our we but at from they will can i me so if',
  es: 'el los las que y en un una por con para es se lo más pero muy como del al su está esto yo',
  fr: 'le les des et est une pour qui dans pas je vous sur ce avec mais très du au il elle sont',
  de: 'der die das und ist nicht ich ein eine mit auf für zu den dem sie wir auch sich aus',
  pt: 'os as do da em um uma não é com mais eu você isso muito na no ao dos das',
  it: 'il lo gli di che è per con non sono mi ma anche questo della nel una un',
  id: 'yang dan di ini itu dengan untuk tidak ada aku saya kamu dari ke akan juga',
  nl: 'het een en van dat niet ik op met voor zijn maar ook wat er',
  tr: 've bir bu için ile çok ama ben sen gibi daha var değil',
}
const STOPWORD_LANG = new Map<string, string[]>()
for (const [lang, words] of Object.entries(STOPWORDS))
  for (const word of words.split(' '))
    STOPWORD_LANG.set(word, [...(STOPWORD_LANG.get(word) ?? []), lang])

const SCRIPTS: [string, RegExp][] = [
  ['kana', /[\p{sc=Hiragana}\p{sc=Katakana}]/u],
  ['han', /\p{sc=Han}/u],
  ['hangul', /\p{sc=Hangul}/u],
  ['latin', /\p{sc=Latin}/u],
  ['cyrillic', /\p{sc=Cyrillic}/u],
  ['arabic', /\p{sc=Arabic}/u],
  ['hebrew', /\p{sc=Hebrew}/u],
  ['greek', /\p{sc=Greek}/u],
  ['thai', /\p{sc=Thai}/u],
  ['devanagari', /\p{sc=Devanagari}/u],
]

/** One CJK character says about as much as a few Latin letters. */
const WEIGHT: Record<string, number> = { kana: 3, han: 3, hangul: 2 }

const NOT_TEXT = /(?<![\w@])@\w+|[#＃][\p{L}\p{M}\p{Nd}_]+/gu
const UKRAINIAN = /[іїєґ]/iu
const PERSIAN = /[پچژگ]/u
const HANDLE_ID = /^handle:/
const NUMERIC = /^\d+$/
const WORD = /[\p{L}\p{M}']+/gu

/**
 * The language of a text, from its scripts and, for Latin script, its
 * commonest small words: `ja`, `zh`, `ko`, `en`, `es`, `fr`, `de`, `pt`,
 * `it`, `id`, `nl`, `tr`, `ru`, `uk`, `ar`, `fa`, `he`, `el`, `th`, `hi`.
 * Null when it cannot tell (no letters, or Latin without any of those
 * words). Japanese is told from Chinese by its kana.
 */
export function detectLang(text: string | null | undefined): string | null {
  if (!text) return null
  const plain = text
    .replaceAll(URL_PATTERN, ' ')
    .replaceAll(NOT_TEXT, ' ')
    .normalize('NFKC')
  const counts: Record<string, number> = {}
  for (const char of plain)
    for (const [script, pattern] of SCRIPTS)
      if (pattern.test(char)) {
        counts[script] = (counts[script] ?? 0) + 1
        break
      }
  const kana = counts.kana ?? 0
  const han = counts.han ?? 0
  // Japanese writes kana between its kanji; Chinese may borrow a の.
  const japanese = kana > 0 && kana >= (kana + han) * 0.2
  const groups: Record<string, number> = {}
  for (const [script, n] of Object.entries(counts)) {
    const group =
      script === 'kana' || script === 'han'
        ? japanese
          ? 'ja'
          : script === 'han'
            ? 'zh'
            : 'ja'
        : script
    groups[group] = (groups[group] ?? 0) + n * (WEIGHT[script] ?? 1)
  }
  const top = Object.entries(groups).toSorted((a, b) => b[1] - a[1])[0]
  if (!top) return null
  switch (top[0]) {
    case 'ja':
    case 'zh':
      return top[0]
    case 'hangul':
      return 'ko'
    case 'cyrillic':
      return UKRAINIAN.test(plain) ? 'uk' : 'ru'
    case 'arabic':
      return PERSIAN.test(plain) ? 'fa' : 'ar'
    case 'hebrew':
      return 'he'
    case 'greek':
      return 'el'
    case 'thai':
      return 'th'
    case 'devanagari':
      return 'hi'
    case 'latin':
      return latinLang(plain)
    default:
      return null
  }
}

function latinLang(text: string): string | null {
  const score: Record<string, number> = {}
  for (const [word] of text.toLowerCase().matchAll(WORD))
    for (const lang of STOPWORD_LANG.get(word) ?? [])
      score[lang] = (score[lang] ?? 0) + 1
  const ranked = Object.entries(score).toSorted(
    (a, b) => b[1] - a[1] || (a[0] === 'en' ? -1 : b[0] === 'en' ? 1 : 0),
  )
  return ranked[0]?.[0] ?? null
}

// --- Reading and writing --------------------------------------------------

interface Source {
  id: number
  platform: string
  profile: number
  text: string | null
  bio: string | null
  website: string | null
  url: string | null
  lang: string | null
}

/** What each row's facets are now, read from its newest revision. */
export function facetsOf(
  db: Executor,
  ids: readonly number[],
): Map<number, Facets> {
  const out = new Map<number, Facets>()
  if (!ids.length) return out
  const rows = db.all<Source>(sql`
    SELECT k.id, c.platform, k.root_kind LIKE '%.profile' AS profile,
      r.payload ->> 'text' AS text,
      root.data -> 'metadata' ->> 'description' AS bio,
      root.data -> 'metadata' -> 'website' ->> 'url' AS website,
      root.data -> 'metadata' ->> 'url' AS url, k.lang
    FROM json_each(${list(ids)}) w
    JOIN catalog k ON k.id = w.value
    JOIN collections c ON c.id = k.collection_id
    JOIN revisions r ON r.id = k.revision_id
    LEFT JOIN revision_entities re ON re.revision_id = k.revision_id AND re.is_root = 1
    LEFT JOIN entity_versions root ON root.id = re.entity_version_id`)
  const mentions = new Map<number, Set<string>>()
  for (const row of db.all<{
    id: number
    platform: string
    username: string | null
    external: string
  }>(sql`
    SELECT k.id, target.platform, tv.data ->> 'username' AS username,
      target.external_id AS external
    FROM json_each(${list(ids)}) w
    JOIN catalog k ON k.id = w.value
    JOIN revision_entities src ON src.revision_id = k.revision_id AND src.is_root = 1
    JOIN entity_relations edge ON edge.revision_id = k.revision_id
      AND edge.source_key = src.entity_key AND edge.kind = 'mentions'
    JOIN revision_entities t ON t.revision_id = edge.revision_id
      AND t.entity_key = edge.target_key
    JOIN entity_versions tv ON tv.id = t.entity_version_id
    JOIN entities target ON target.id = tv.entity_id`)) {
    const handle =
      row.username || row.external.replace(HANDLE_ID, '').replace(NUMERIC, '')
    if (!handle) continue
    const set = mentions.get(row.id) ?? new Set<string>()
    set.add(mentionValue(row.platform, handle))
    mentions.set(row.id, set)
  }
  for (const row of rows) {
    // An account's text is its bio, as search reads it; its own address
    // on X (`metadata.url`) is no link of its.
    const text = (row.profile ? (row.bio ?? row.text) : row.text) ?? ''
    const sites = row.profile
      ? [row.website, row.platform === 'x' ? null : row.url].filter(
          (s): s is string => !!s,
        )
      : []
    out.set(row.id, {
      lang: detectLang(text),
      hashtags: hashtagsOf(text),
      mentions: [...(mentions.get(row.id) ?? [])],
      domains: domainsOf(text, sites),
    })
  }
  return out
}

/**
 * Bring these catalog rows' facets up to date, writing only what differs.
 * Returns how many values (and languages) were written or removed.
 */
export function indexFacets(db: Executor, ids: readonly number[]): number {
  if (!ids.length) return 0
  const next = facetsOf(db, ids)
  let written = 0
  const langs = db.all<{ id: number; lang: string | null }>(
    sql`SELECT id, lang FROM catalog WHERE id IN (SELECT value FROM json_each(${list(ids)}))`,
  )
  for (const { id, lang } of langs) {
    const want = next.get(id)?.lang ?? null
    if (want === lang) continue
    db.run(sql`UPDATE catalog SET lang = ${want} WHERE id = ${id}`)
    written++
  }
  for (const [kind, table] of Object.entries(FACET_TABLES) as [
    FacetKind,
    string,
  ][]) {
    const stored = new Map<number, Set<string>>()
    for (const row of db.all<{ id: number; value: string }>(sql`
      SELECT catalog_id AS id, value FROM ${sql.identifier(table)}
      WHERE catalog_id IN (SELECT value FROM json_each(${list(ids)}))`)) {
      const set = stored.get(row.id) ?? new Set<string>()
      set.add(row.value)
      stored.set(row.id, set)
    }
    const drop: [number, string][] = []
    const add: [number, string][] = []
    for (const id of ids) {
      const want = new Set(next.get(id)?.[kind])
      const have = stored.get(id) ?? new Set<string>()
      for (const value of have) if (!want.has(value)) drop.push([id, value])
      for (const value of want) if (!have.has(value)) add.push([id, value])
    }
    if (drop.length)
      db.run(sql`DELETE FROM ${sql.identifier(table)}
        WHERE (catalog_id, value) IN (
          SELECT value ->> 0, value ->> 1 FROM json_each(${list(drop)}))`)
    if (add.length)
      db.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table)} (catalog_id, value)
        SELECT value ->> 0, value ->> 1 FROM json_each(${list(add)})`)
    written += drop.length + add.length
  }
  return written
}

// --- Backfill -------------------------------------------------------------

/**
 * Bumped when what is extracted changes, so the backfill goes over every
 * row again.
 */
export const FACETS_VERSION = 1
export const BACKFILL_KEY = 'facets_backfill'

export interface BackfillState {
  version: number
  /** The highest catalog id done. */
  after: number
  done: boolean
}

export function backfillState(db: Database): BackfillState {
  try {
    const state = JSON.parse(
      readSetting(db, BACKFILL_KEY) ?? '',
    ) as BackfillState
    if (state.version === FACETS_VERSION) return state
  } catch {}
  return { version: FACETS_VERSION, after: 0, done: false }
}

/** Whether every row's facets are filled, so counts over them may be kept. */
export const facetsComplete = (db: Database) => backfillState(db).done

/**
 * The next batch of rows catalogued before the facets existed, in one write
 * transaction with the progress it makes; false when there were none left.
 */
export function backfillBatch(db: Database, size = 500): boolean {
  return db.transaction((tx) => {
    const state = backfillState(db)
    if (state.done) return false
    const ids = tx
      .all<{ id: number }>(
        sql`SELECT id FROM catalog WHERE id > ${state.after} ORDER BY id LIMIT ${size}`,
      )
      .map((row) => row.id)
    indexFacets(tx, ids)
    const next: BackfillState = {
      version: FACETS_VERSION,
      after: ids.at(-1) ?? state.after,
      done: ids.length < size,
    }
    tx.run(sql`INSERT INTO settings (key, value) VALUES (${BACKFILL_KEY}, ${JSON.stringify(next)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    return !next.done
  })
}
