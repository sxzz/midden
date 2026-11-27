import { afterEach, describe, expect, test } from 'vitest'
import { backfillFacets } from '#capture/maintenance.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import {
  backfillState,
  detectLang,
  domainOf,
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

  test('language: from the scripts, and Latin from its small words', () => {
    expect(detectLang('今日は猫の日です')).toBe('ja')
    expect(detectLang('鏡音レン')).toBe('ja')
    expect(detectLang('今天天气很好')).toBe('zh')
    expect(detectLang('我の猫今天很可爱很可爱')).toBe('zh')
    expect(detectLang('오늘 날씨가 좋네요')).toBe('ko')
    expect(detectLang('The cat is on the mat')).toBe('en')
    expect(detectLang('El gato está en la casa')).toBe('es')
    expect(detectLang("C'est une très belle journée pour le chat")).toBe('fr')
    expect(detectLang('Привет, как дела?')).toBe('ru')
    expect(detectLang('今日はcodingした')).toBe('ja')
    expect(detectLang('lol')).toBeNull()
    expect(detectLang('🎉🎉 https://a.test @alice #tag')).toBeNull()
    expect(detectLang('')).toBeNull()
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
})
