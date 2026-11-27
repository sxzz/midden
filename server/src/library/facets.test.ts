import { afterEach, describe, expect, test } from 'vitest'
import { backfillFacets } from '#capture/maintenance.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import {
  BACKFILL_KEY,
  backfillState,
  domainOf,
  FACETS_VERSION,
  hashtagsOf,
  registrableDomain,
} from './facets.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

describe('values', () => {
  test('hashtags: folded, each once, not in links, words or entities', () => {
    expect(
      hashtagsOf(
        '#猫 #Cat #ＣＡＴ #123 x#y &#39; https://a.test/#frag #鏡音レン・リン ＃日本',
      ),
    ).toEqual(['猫', 'cat', '鏡音レン・リン', '日本'])
  })

  test('domains: registrable, lower case, without www', () => {
    expect(registrableDomain('WWW.YouTube.com')).toBe('youtube.com')
    expect(registrableDomain('music.youtube.com')).toBe('youtube.com')
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('www.city.shibuya.tokyo.jp')).toBe('tokyo.jp')
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io')
    expect(registrableDomain('x.com')).toBe('x.com')
    expect(registrableDomain('192.168.0.1')).toBe('192.168.0.1')
    expect(domainOf('https://www.pixiv.net/artworks/1')).toBe('pixiv.net')
    expect(domainOf('pixiv.net')).toBe('pixiv.net')
    expect(domainOf('https://t.co/abc')).toBeUndefined()
    expect(domainOf('mailto:a@b.c')).toBeUndefined()
  })
})

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

/** A post on the fake platform with this text, mentioning these handles. */
function post(id: string, text: string, mentions: string[] = []) {
  return (): Partial<FetchResponse> => ({
    text,
    graph: graph(
      [
        entity('root', 'fake.post', id, { text }),
        entity('author', 'fake.profile', '7', { username: 'alice' }),
        ...mentions.map((handle) =>
          entity(`m_${handle}`, 'fake.profile', `handle:${handle}`, {
            username: handle,
          }),
        ),
      ],
      ['root', 'authored_by', 'author'],
      ...mentions.map(
        (handle) =>
          ['root', 'mentions', `m_${handle}`] as [string, string, string],
      ),
    ),
  })
}

function setup(routes: Record<string, () => Partial<FetchResponse>>) {
  const made = libraryContext((req) => routes[req.externalId]!())
  ctx = made.ctx
  return made.ctx
}

function facetRows(c: CaptureContext) {
  const all = (sql: string) =>
    c.db.$client.prepare(sql).all() as Record<string, unknown>[]
  return {
    lang: all('SELECT lang FROM catalog ORDER BY id').map((r) => r.lang),
    hashtags: all('SELECT value FROM post_hashtags ORDER BY value').map(
      (r) => r.value,
    ),
    mentions: all('SELECT value FROM post_mentions ORDER BY value').map(
      (r) => r.value,
    ),
    domains: all('SELECT value FROM post_domains ORDER BY value').map(
      (r) => r.value,
    ),
  }
}

/** Every row a statement writes to the facets, logged by temporary triggers. */
function logFacetWrites(c: CaptureContext) {
  const client = c.db.$client
  client.exec('CREATE TEMP TABLE facet_writes (what TEXT)')
  for (const table of ['post_hashtags', 'post_mentions', 'post_domains'])
    for (const event of ['INSERT', 'DELETE', 'UPDATE'])
      client.exec(`CREATE TEMP TRIGGER ${table}_${event} AFTER ${event} ON main.${table}
        BEGIN INSERT INTO facet_writes VALUES ('${table} ${event}'); END`)
  client.exec(`CREATE TEMP TRIGGER catalog_lang AFTER UPDATE OF lang ON main.catalog
    BEGIN INSERT INTO facet_writes VALUES ('catalog lang'); END`)
  return () =>
    (
      client.prepare('SELECT what FROM facet_writes').all() as {
        what: string
      }[]
    ).map((r) => r.what)
}

describe('facets of captured items', () => {
  test('are written with the revision, and not again for an unchanged capture', async () => {
    const routes: Record<string, () => Partial<FetchResponse>> = {
      p1: post(
        'p1',
        'The #Cats of https://www.youtube.com/watch?v=1 and @bob',
        ['bob'],
      ),
    }
    const c = setup(routes)
    await capture(c, 'https://fake.test/p/p1')
    expect(facetRows(c)).toEqual({
      lang: ['en'],
      hashtags: ['cats'],
      mentions: ['fake:bob'],
      domains: ['youtube.com'],
    })
    const writes = logFacetWrites(c)
    const again = () =>
      capture(c, { url: 'https://fake.test/p/p1', refetch: true })
    const captures = () =>
      c.db.$client.prepare('SELECT count(*) AS n FROM captures').get()!.n
    await again()
    expect(captures()).toBe(2)
    // Captured again unchanged: the same revision, nothing written.
    expect(writes()).toEqual([])
    // Changed: only what differs.
    routes.p1 = post(
      'p1',
      'The #Cats and #dogs of https://youtu.be/1 and @bob',
      ['bob'],
    )
    await again()
    expect(facetRows(c)).toEqual({
      lang: ['en'],
      hashtags: ['cats', 'dogs'],
      mentions: ['fake:bob'],
      domains: ['youtu.be'],
    })
    expect(writes().toSorted()).toEqual([
      'post_domains DELETE',
      'post_domains INSERT',
      'post_hashtags INSERT',
    ])
  })

  test('language: detected again when the text changes, from the bio for an account', async () => {
    const routes: Record<string, () => Partial<FetchResponse>> = {
      p1: post('p1', 'The cat sat on the mat all afternoon'),
      8: () => ({
        text: 'Bob',
        graph: graph([
          entity('root', 'fake.profile', '8', {
            username: 'bob',
            name: 'Bob',
            metadata: { description: '画画的，偶尔发日常。约稿请私信' },
          }),
        ]),
      }),
    }
    const c = setup(routes)
    await capture(c, 'https://fake.test/p/p1')
    await capture(c, 'https://fake.test/u/8')
    const langs = () =>
      Object.fromEntries(
        (
          c.db.$client
            .prepare(
              'SELECT root_kind AS kind, lang FROM catalog ORDER BY root_kind',
            )
            .all() as { kind: string; lang: string | null }[]
        ).map((r) => [r.kind, r.lang]),
      )
    expect(langs()).toEqual({ 'fake.post': 'en', 'fake.profile': 'zh-Hans' })
    const writes = logFacetWrites(c)
    routes.p1 = post('p1', '今日は猫の日です。一日中ずっと寝ていました')
    await capture(c, { url: 'https://fake.test/p/p1', refetch: true })
    expect(langs()).toEqual({ 'fake.post': 'ja', 'fake.profile': 'zh-Hans' })
    expect(writes()).toEqual(['catalog lang'])
    // A new text in the same language: a new revision, the same language,
    // so nothing written for it.
    routes.p1 = post('p1', '明日は雨が降るらしいので、傘を持っていきます')
    await capture(c, { url: 'https://fake.test/p/p1', refetch: true })
    expect(writes()).toEqual(['catalog lang'])
  })

  test('go with the catalog row', async () => {
    const c = setup({ p1: post('p1', '#a #b https://a.test', ['bob']) })
    await capture(c, 'https://fake.test/p/p1')
    c.db.$client.exec('DELETE FROM catalog')
    expect(facetRows(c)).toEqual({
      lang: [],
      hashtags: [],
      mentions: [],
      domains: [],
    })
  })

  test('are filled for older rows by maintenance, resuming where it stopped', async () => {
    const routes: Record<string, () => Partial<FetchResponse>> = {}
    for (let i = 0; i < 5; i++)
      routes[`p${i}`] = post(`p${i}`, `#tag${i} 今日は猫の日`, [`u${i}`])
    const c = setup(routes)
    for (let i = 0; i < 5; i++) await capture(c, `https://fake.test/p/p${i}`)
    const filled = facetRows(c)
    expect(filled.hashtags).toHaveLength(5)
    // As before the tables existed.
    c.db.$client.exec(`
      DELETE FROM post_hashtags; DELETE FROM post_mentions;
      DELETE FROM post_domains; UPDATE catalog SET lang = NULL;
      DELETE FROM settings WHERE key = 'facets_backfill'`)
    // Not idle: nothing.
    expect(await backfillFacets(c, () => false)).toBe(0)
    expect(backfillState(c.db).after).toBe(0)
    // One batch of two, then the worker is busy.
    let turns = 1
    expect(await backfillFacets(c, () => turns-- > 0, 2)).toBe(1)
    expect(backfillState(c.db)).toMatchObject({ done: false })
    expect(facetRows(c).hashtags).toEqual(['tag0', 'tag1'])
    expect(await backfillFacets(c, () => true, 2)).toBe(2)
    expect(backfillState(c.db).done).toBe(true)
    expect(facetRows(c)).toEqual(filled)
  })

  test('are filled again from the start when the version moves', async () => {
    const c = setup({ p1: post('p1', '今天天气很好，我们去公园散步吧') })
    await capture(c, 'https://fake.test/p/p1')
    expect(facetRows(c).lang).toEqual(['zh-Hans'])
    // As the previous version left it: done, with its own language.
    c.db.$client.exec("UPDATE catalog SET lang = 'zh'")
    c.db.$client
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(
        BACKFILL_KEY,
        JSON.stringify({ version: FACETS_VERSION - 1, after: 99, done: true }),
      )
    expect(backfillState(c.db)).toEqual({
      version: FACETS_VERSION,
      after: 0,
      done: false,
    })
    await backfillFacets(c)
    expect(backfillState(c.db).done).toBe(true)
    expect(facetRows(c).lang).toEqual(['zh-Hans'])
  })
})
