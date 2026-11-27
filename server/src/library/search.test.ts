import { readdirSync, readFileSync } from 'node:fs'
import { asc } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { collectCollections } from '#capture/maintenance.ts'
import { catalog } from '#db/schema.ts'
import {
  capture,
  entity,
  expectCatalogFresh,
  graph,
  image,
  libraryContext,
  searchIndexes,
} from '#testing/library.ts'
import { catalogMissing } from './catalog.ts'
import { filterCounts } from './counts.ts'
import { deleteCollections } from './delete.ts'
import { indexFacets } from './facets.ts'
import { createFolder } from './folders.ts'
import {
  countCollections,
  listCollections,
  type CollectionFilter,
  type Narrowing,
} from './list.ts'
import { countPublicCollections, listPublicCollections } from './public.ts'
import { fold, parseSearch } from './search-text.ts'
import { FUZZY_BELOW } from './search.ts'
import { createShare } from './shares.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  if (ctx) expectCatalogFresh(ctx)
  ctx = undefined
})

type Route = () => Partial<FetchResponse>

interface Post {
  text?: string
  author?: string
  handle?: string
  published?: string
  alt?: string
  quotes?: string
}

const post = (id: string) => `https://fake.test/p/${id}`

function route(id: string, p: Post): Route {
  return () => {
    const entities = [entity('root', 'fake.post', id, { text: p.text ?? '' })]
    const relations: [string, string, string][] = []
    if (p.author) {
      entities.push(
        entity('author', 'fake.profile', `u-${p.handle ?? p.author}`, {
          name: p.author,
          username: p.handle ?? '',
        }),
      )
      relations.push(['root', 'authored_by', 'author'])
    }
    if (p.quotes) {
      entities.push(entity('quote', 'fake.post', p.quotes))
      relations.push(['root', 'quoted', 'quote'])
    }
    return {
      text: p.text ?? '',
      ...(p.author ? { authorName: p.author } : {}),
      ...(p.published ? { publishedAt: p.published } : {}),
      ...(p.alt ? { resources: [image(`${id}.jpg`, { altText: p.alt })] } : {}),
      graph: graph(entities, ...relations),
    }
  }
}

/** Capture these posts in order; their collection ids by name. */
async function library(posts: Record<string, Post>) {
  const routes: Record<string, Route> = {}
  for (const [id, p] of Object.entries(posts)) routes[id] = route(id, p)
  const made = libraryContext((req) => {
    const r = routes[req.externalId]
    if (!r) throw new Error(`no route for ${req.externalId}`)
    return r()
  })
  ctx = made.ctx
  const ids: Record<string, string> = {}
  for (const id of Object.keys(posts))
    ids[id] = (await capture(made.ctx, post(id))).collectionId
  const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]))
  /** Every page of a listing, by name. */
  const all = (filter: CollectionFilter, narrow?: Narrowing) => {
    const found: string[] = []
    let cursor: string | undefined
    do {
      const page = listCollections(made.ctx, filter, cursor, narrow)
      found.push(...page.items.map((c) => names.get(c.id) ?? c.id))
      cursor = page.next_cursor
    } while (cursor)
    return found
  }
  return { ctx: made.ctx, ids, routes, all }
}

const day = (n: number) => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`

describe('folding', () => {
  test('case, width and script fold to one form, twice the same', () => {
    expect(fold('ＨＥＬＬＯ　Ｗｏｒｌｄ')).toBe('hello world')
    expect(fold('終末地 遊戲')).toBe('终末地 游戏')
    expect(fold('  a​b \n\t c  ')).toBe('ab c')
    expect(fold('ｶﾀｶﾅ')).toBe('カタカナ')
    for (const text of ['終末地 遊戲', 'ＡＢＣ', '乾隆 髮型 臺灣'])
      expect(fold(fold(text))).toBe(fold(text))
  })

  test('terms the index can find, and the rest', () => {
    const query = parseSearch('原神 a xiaomuoz')!
    expect(query.terms).toEqual(['原神', 'a', 'xiaomuoz'])
    expect(query.short).toEqual(['a'])
    expect(query.words).toBe('"原神"')
    expect(query.trigrams).toBe('"xiaomuoz"')
    // The pair, and the six trigrams of the long term.
    expect(query.fuzzy).toEqual({
      trigrams: ['xia', 'iao', 'aom', 'omu', 'muo', 'uoz'],
      pairs: ['原神'],
      min: 4,
    })
    expect(parseSearch('  ')).toBeUndefined()
    expect(parseSearch('猫')).toMatchObject({ short: [], words: '"猫"' })
    expect(parseSearch('ai')).toMatchObject({ short: ['ai'] })
  })
})

describe('library search', () => {
  test('tiers come first, the chosen order within each', async () => {
    const { all } = await library({
      // Tier 3: the word only in a media description, newest.
      alt: { text: 'a photo', alt: 'the moonlit garden', published: day(9) },
      // Tier 2: in the text.
      old: { text: 'notes on moonlit nights', published: day(1) },
      mid: { text: 'moonlit walk', published: day(5) },
      // Tier 1: the author is called that.
      name: { text: 'hello', author: 'Moonlit', published: day(2) },
      // Tier 4: some of its trigrams, as there are few better matches.
      apart: { text: 'garden by moon, lit later', published: day(8) },
      none: { text: 'unrelated', published: day(7) },
    })
    expect(all({ q: 'moonlit' })).toEqual([
      'name',
      'mid',
      'old',
      'alt',
      'apart',
    ])
    expect(all({ q: 'moonlit', sort: 'published' })).toEqual([
      'name',
      'mid',
      'old',
      'alt',
      'apart',
    ])
    expect(
      all({ q: 'moonlit', sort: 'published', order: 'asc' }).slice(1, 3),
    ).toEqual(['old', 'mid'])
    // Every term, apart, ranks below the phrase.
    expect(all({ q: 'moonlit garden' })[0]).toBe('alt')
    expect(all({ q: 'garden moon' })).toEqual(['apart', 'alt'])
    // Without a search, relevance is the default order.
    expect(all({ sort: 'relevance' })).toEqual(all({}))
  })

  test('relevance orders a tier by the weighted columns', async () => {
    const { all } = await library({
      quoted: { text: 'quoting', quotes: 'src' },
      src: { text: 'zephyr source' },
      alt: { text: 'image', alt: 'zephyr' },
      text: { text: 'zephyr' },
    })
    // The quoted post's own text sits in tier 2; the quoting one's copy of
    // it outranks a media description in tier 3.
    expect(all({ q: 'zephyr' })).toEqual(['text', 'src', 'quoted', 'alt'])
  })

  test('two CJK characters, scripts, case and width', async () => {
    const { all } = await library({
      genshin: { text: '今天也在玩原神' },
      other: { text: '原来如此' },
      end: { text: '终末地的联动', author: '作者' },
      latin: { text: 'Hello ＷＯＲＬＤ' },
      cat: { text: '一只猫' },
    })
    expect(all({ q: '原神' })).toEqual(['genshin'])
    expect(all({ q: '原' })).toEqual(['genshin', 'other'].toReversed())
    expect(all({ q: '終末' })).toEqual(['end'])
    expect(all({ q: '聯動' })).toEqual(['end'])
    expect(all({ q: 'world' })).toEqual(['latin'])
    expect(all({ q: 'ｈｅｌｌｏ' })).toEqual(['latin'])
    expect(all({ q: 'HELLO world' })).toEqual(['latin'])
    expect(all({ q: '猫' })).toEqual(['cat'])
    expect(all({ q: '作者' })).toEqual(['end'])
  })

  test('a typo finds by trigrams when little else does', async () => {
    const { ctx, all } = await library({
      handle: { text: 'drawing', author: 'Mou', handle: 'xiaomouz' },
      text: { text: 'art by xiaomouz today' },
      far: { text: 'xiaoming' },
    })
    // Sharing a prefix is a partial match, after the real ones.
    expect(all({ q: 'xiaomouz' })).toEqual(['handle', 'text', 'far'])
    // Only the handle is the whole query; the text has all but `@xi`.
    expect(all({ q: '@xiaomouz' })).toEqual(['handle', 'text'])
    // Three of the six trigrams of the misspelling are right, as they are
    // for a name sharing its start.
    expect(all({ q: 'xiaomuoz' }).toSorted()).toEqual(['far', 'handle', 'text'])
    expect(countCollections(ctx.db, { q: 'xiaomuoz' }).count).toBe(3)
    expect(all({ q: 'qqqqqq' })).toEqual([])
  })

  test('several terms: all of them first, then some', async () => {
    const { all } = await library({
      both: { text: 'a pillow for my cat', published: day(1) },
      phrase: { text: 'cat pillow', published: day(2) },
      one: { text: 'pillows only', published: day(3) },
      other: { text: 'just a cat', published: day(4) },
    })
    expect(all({ q: 'cat pillow' })).toEqual(['phrase', 'both', 'one'])
    expect(all({ q: 'cat pillow', sort: 'published' })).toEqual([
      'phrase',
      'both',
      'one',
    ])
  })

  test('fuzzy matches stay out when the strict tiers find enough', async () => {
    const posts: Record<string, Post> = { typo: { text: 'kitchen' } }
    for (let i = 0; i < FUZZY_BELOW; i++)
      posts[`k${i}`] = { text: `kitchens ${i}`, published: day(i + 1) }
    const { all } = await library(posts)
    expect(all({ q: 'kitchenz' })).toContain('typo')
    expect(all({ q: 'kitchens' })).not.toContain('typo')
  })

  test('pages hold their place across tiers', async () => {
    const posts: Record<string, Post> = {}
    for (let i = 0; i < 45; i++)
      posts[`p${i}`] = {
        text: i % 3 ? `spring rain ${i}` : `rain, then spring ${i}`,
        published: day((i % 28) + 1),
        ...(i % 7 ? {} : { author: 'spring rain' }),
      }
    const { ctx, all } = await library(posts)
    for (const sort of ['relevance', 'published', 'updated', 'storage']) {
      const found = all({ q: 'spring rain', sort })
      expect(found).toHaveLength(45)
      expect(new Set(found).size).toBe(45)
      expect(countCollections(ctx.db, { q: 'spring rain', sort }).count).toBe(
        45,
      )
    }
    // A cursor is for its own query.
    const first = listCollections(ctx, { q: 'spring rain' })
    expect(() =>
      listCollections(ctx, { q: 'spring' }, first.next_cursor),
    ).toThrow('翻页位置无效，请刷新后重试')
    expect(() =>
      listCollections(ctx, { q: 'spring rain', sort: 'published' }, 'x'),
    ).toThrow('翻页位置无效，请刷新后重试')
  })

  test('counts, folders and public lists search the same way', async () => {
    const { ctx, ids, all } = await library({
      a: { text: 'blue whale song' },
      b: { text: 'blue sky' },
      c: { text: 'whale watching' },
    })
    const folder = createFolder(ctx.db, {
      name: '鲸',
      filter: 'q=  Whale \t ',
    })
    expect(folder.filter).toBe('q=Whale')
    expect(filterCounts(ctx.db, folder.filter!).count).toBe(2)
    expect(filterCounts(ctx.db, 'q=whale').count).toBe(2)
    expect(all({ q: 'Whale' })).toEqual(['c', 'a'])

    const slug = createShare(ctx.db, { target: 'folder', id: folder.id }).slug
    const accounts = ctx as AccountsContext
    const listed = (q: string) =>
      listPublicCollections(accounts, slug, { q }).items.map((c) => c.id)
    expect(listed('')).toHaveLength(2)
    // The visitor's search narrows the share and ranks; it never widens it.
    expect(listed('song')).toEqual([ids.a])
    expect(listed('blue')).toEqual([ids.a])
    expect(listed('sky')).toEqual([])
    expect(countPublicCollections(accounts, slug, { q: 'blue' }).count).toBe(1)
    expect(all({ q: 'blue' }, { q: 'whale' })).toEqual(['a'])
  })

  test('the index follows the catalog: changes, quotes, deletes, rebuilds', async () => {
    const { ctx, ids, routes, all } = await library({
      // Quotes a post captured after it.
      quoting: { text: 'look at this', quotes: 'quoted' },
      quoted: { text: 'a marmalade sunset' },
      edited: { text: 'first draft' },
    })
    expect(all({ q: 'marmalade' })).toEqual(['quoted', 'quoting'])

    routes.edited = route('edited', { text: 'second version' })
    await capture(ctx, { refreshId: ids.edited! })
    expect(all({ q: 'draft' })).toEqual([])
    expect(all({ q: 'second version' })).toEqual(['edited'])

    // The quoted post changes: so does what finds the quoting one.
    routes.quoted = route('quoted', { text: 'an apricot sunrise' })
    await capture(ctx, { refreshId: ids.quoted! })
    expect(all({ q: 'marmalade' })).toEqual([])
    expect(all({ q: 'apricot' })).toEqual(['quoted', 'quoting'])

    deleteCollections(ctx.db, [ids.edited!])
    expect(all({ q: 'second' })).toEqual([])
    // Its content goes later, and its catalog row with it.
    const rowids = () =>
      ctx.db.$client
        .prepare('SELECT count(*) AS n FROM catalog_fts_docsize')
        .get() as { n: number }
    expect(rowids().n).toBe(3)
    await collectCollections(ctx)
    expect(rowids().n).toBe(2)

    // Emptied and refilled, as a migration that changes the catalog does.
    ctx.db.delete(catalog).run()
    expect(rowids().n).toBe(0)
    catalogMissing(ctx.db)
    expect(all({ q: 'apricot' })).toEqual(['quoted', 'quoting'])
  })

  test('the migration fills the search columns and the index', async () => {
    const { ctx, all } = await library({
      a: { text: '終末地 Ｆａｎ art', author: 'Ann', handle: 'ann_x' },
      b: { text: 'quoting', quotes: 'a', alt: 'Sunset' },
    })
    // The language came later, with the facets.
    const rows = () =>
      ctx.db
        .select()
        .from(catalog)
        .orderBy(asc(catalog.collectionId))
        .all()
        .map(({ lang: _, ...row }) => row)
    const kept = rows()
    // Back to the catalog before the migrations, then through them (and
    // the one that gives it its id, as the first rebuilds the table).
    const client = ctx.db.$client
    client.exec(`DROP TRIGGER catalog_search_insert;
      DROP TRIGGER catalog_search_update;
      DROP TRIGGER catalog_search_delete;
      DROP TABLE catalog_fts_terms;
      DROP TABLE catalog_cjk_terms;
      DROP TABLE catalog_fts;
      DROP TABLE catalog_cjk;
      ALTER TABLE catalog DROP COLUMN search_name;
      ALTER TABLE catalog DROP COLUMN search_quoted;
      ALTER TABLE catalog DROP COLUMN search_extra;
      ALTER TABLE catalog RENAME COLUMN search_text TO search;
      UPDATE catalog SET search = 'the old text';`)
    const folder = new URL('../../drizzle/', import.meta.url)
    const migrations = readdirSync(folder)
      .filter((name) =>
        /_(?:search_columns|catalog_fts|catalog_id)$/.test(name),
      )
      .toSorted()
    expect(migrations).toHaveLength(3)
    const started = performance.now()
    for (const name of migrations)
      for (const statement of readFileSync(
        new URL(`${name}/migration.sql`, folder),
        'utf8',
      ).split('--> statement-breakpoint'))
        client.exec(statement)
    expect(performance.now() - started).toBeLessThan(1000)
    // The later migration that adds the language, filled as maintenance
    // fills it.
    client.exec('ALTER TABLE catalog ADD lang text')
    indexFacets(
      ctx.db,
      ctx.db
        .select({ id: catalog.id })
        .from(catalog)
        .all()
        .map((row) => row.id),
    )
    expect(rows()).toEqual(kept)
    const index = searchIndexes(ctx.db)
    expect(index.kept.length).toBeGreaterThan(0)
    expect(index.kept).toEqual(index.fresh)
    expect(all({ q: '终末' })).toEqual(['a', 'b'])
    expect(all({ q: 'ann' })).toEqual(['a', 'b'])
    expect(all({ q: 'sunset' })).toEqual(['b'])
  })
})
