import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createApi } from '#http/app.ts'
import { SESSION_COOKIE, SESSION_TTL } from '#http/sessions.ts'
import { checkSearchIndexes, intact } from '#library/search-index.ts'
import { softAuthenticator } from '#testing/authenticator.ts'
import { testContext } from '#testing/context.ts'
import { insertRow, migratedBefore, migrateRest } from '#testing/migrations.ts'
import { openDatabase, type Database } from './client.ts'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server'

const columns = (db: Database, table: string) =>
  db.$client
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all(table)
    .map((row) => row.name)

const indexes = (db: Database, table: string) =>
  db.$client
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
    )
    .all(table)
    .map((row) => row.name)

describe('raw_response_bodies', () => {
  test('a fresh database keeps bodies in their own table', () => {
    const db = openDatabase(':memory:')
    expect(columns(db, 'source_responses')).not.toContain('body')
    expect(columns(db, 'source_responses')).not.toContain('remote_at')
    expect(columns(db, 'source_response_bodies')).toEqual([
      'response_id',
      'body',
    ])
    expect(indexes(db, 'source_responses')).toEqual([
      'source_responses_position',
      'source_responses_sha256',
    ])
  })

  test('a database shaped like production keeps only the bodies still here', () => {
    const db = migratedBefore('raw_response_bodies')
    insertRow(db, 'collections', { id: 'c1' })
    insertRow(db, 'captures', { id: 'k1', collection_id: 'c1' })
    // Stored in the bucket: cleared, and moved past the others.
    const stored = Array.from({ length: 50 }, (_, i) => `s${i}`)
    for (const [i, id] of stored.entries())
      insertRow(db, 'source_responses', {
        id,
        capture_id: 'k1',
        position: i,
        body: Buffer.alloc(0),
        sha256: `sha-${id}`,
        size: 1000 + i,
        created_at: 1,
        remote_at: 2,
      })
    // Still here: one waiting for the upload, one found corrupt.
    for (const [i, id] of ['l1', 'l2'].entries())
      insertRow(db, 'source_responses', {
        id,
        capture_id: 'k1',
        position: 100 + i,
        body: Buffer.from(`body ${id}`),
        sha256: `sha-${id}`,
        size: 7,
        created_at: 1,
        remote_at: null,
      })
    insertRow(db, 'raw_upload_failures', {
      response_id: 'l2',
      failures: 1,
      retry_at: null,
      error: 'hash',
    })
    const before = db.$client
      .prepare('SELECT id, sha256, size FROM source_responses ORDER BY id')
      .all()

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT id, sha256, size FROM source_responses ORDER BY id')
        .all(),
    ).toEqual(before)
    expect(
      db.$client
        .prepare(
          'SELECT response_id, CAST(body AS TEXT) AS body FROM source_response_bodies ORDER BY response_id',
        )
        .all(),
    ).toEqual([
      { response_id: 'l1', body: 'body l1' },
      { response_id: 'l2', body: 'body l2' },
    ])
    // Dropping the columns cascades nothing.
    expect(
      db.$client.prepare('SELECT response_id FROM raw_upload_failures').all(),
    ).toEqual([{ response_id: 'l2' }])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.$client.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    })
  })
})

describe('catalog_id', () => {
  /** The collections an index finds for a query: by the rowid, before and after. */
  const find = (db: Database, index: string, query: string) =>
    db.$client
      .prepare(
        `SELECT k.collection_id AS id FROM ${index} f JOIN catalog k ON k.rowid = f.rowid
          WHERE ${index} MATCH ? ORDER BY 1`,
      )
      .all(query)
      .map((row) => row.id)

  test('a fresh database keys the catalog by an INTEGER PRIMARY KEY', () => {
    const db = openDatabase(':memory:')
    expect(
      db.$client
        .prepare(
          `SELECT name, type, pk FROM pragma_table_info('catalog') WHERE pk > 0`,
        )
        .all(),
    ).toEqual([{ name: 'id', type: 'INTEGER', pk: 1 }])
  })

  test('rows keep their rowids as ids, so the search indexes stay as they are', () => {
    const db = migratedBefore('catalog_id')
    const add = (id: string, text: string) => {
      insertRow(db, 'collections', { id, external_id: id })
      insertRow(db, 'catalog', { collection_id: id, search_text: text })
    }
    for (let i = 1; i <= 20; i++)
      add(
        `c${String(i).padStart(2, '0')}`,
        `post number ${i} ${i % 2 ? '猫咪' : '小狗'}`,
      )
    // Gaps, as deletions leave them.
    db.$client.exec(
      `DELETE FROM catalog WHERE collection_id IN ('c03', 'c06', 'c09', 'c12')`,
    )
    const keys = db.$client
      .prepare('SELECT rowid AS id, collection_id FROM catalog ORDER BY rowid')
      .all()
    const cats = find(db, 'catalog_cjk', '"猫咪"')
    const numbers = find(db, 'catalog_fts', '"number 1"')
    expect(cats).toHaveLength(8)

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT id, collection_id FROM catalog ORDER BY id')
        .all(),
    ).toEqual(keys)
    expect(find(db, 'catalog_cjk', '"猫咪"')).toEqual(cats)
    expect(find(db, 'catalog_fts', '"number 1"')).toEqual(numbers)
    expect(checkSearchIndexes(db).every(intact)).toBe(true)

    // The triggers follow the new key.
    add('c21', 'brand new')
    expect(find(db, 'catalog_fts', '"brand new"')).toEqual(['c21'])
    db.$client.exec(
      `UPDATE catalog SET search_text = 'renamed' WHERE collection_id = 'c21'`,
    )
    expect(find(db, 'catalog_fts', '"brand new"')).toEqual([])
    expect(find(db, 'catalog_fts', '"renamed"')).toEqual(['c21'])
    db.$client.exec(`DELETE FROM catalog WHERE collection_id = 'c21'`)
    expect(find(db, 'catalog_fts', '"renamed"')).toEqual([])
    expect(checkSearchIndexes(db).every(intact)).toBe(true)
    expect(db.$client.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    })
  })
})

describe('watches', () => {
  test('queued maintenance work moves to the rank below watch runs', () => {
    const db = migratedBefore('watches')
    const jobs: [string, number][] = [
      ['capture', 0],
      ['capture', 1],
      ['capture', 2],
      ['upload', 4],
      ['upload', 5],
      ['upload', 6],
    ]
    for (const [i, [type, priority]] of jobs.entries())
      insertRow(db, 'jobs', { id: i + 1, type, ref: `r${i}`, priority })
    insertRow(db, 'updates', { id: 'u1', collection_ids: '[]', options: '{}' })

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT type, priority FROM jobs ORDER BY id')
        .all()
        .map((row) => [row.type, row.priority]),
    ).toEqual([
      ['capture', 0],
      ['capture', 1],
      ['capture', 3],
      // Only thumbnail renders had a priority of their own; they are gone.
      ['upload', 4],
      ['upload', 5],
      ['upload', 6],
    ])
    // Updates so far were all started by hand.
    expect(
      db.$client.prepare('SELECT origin, watch_id FROM updates').all(),
    ).toEqual([{ origin: 'manual', watch_id: null }])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('watch_intervals', () => {
  test('the fixed choices become a number and a unit, keeping their slots and runs', () => {
    const db = migratedBefore('watch_intervals')
    insertRow(db, 'folders', { id: 'f1', name: 'a', filter: '' })
    insertRow(db, 'folders', { id: 'f2', name: 'b', filter: '' })
    insertRow(db, 'folders', { id: 'f3', name: 'c', filter: '' })
    for (const [id, folder, frequency] of [
      ['w1', 'f1', '6h'],
      ['w2', 'f2', 'daily'],
      ['w3', 'f3', 'weekly'],
    ])
      insertRow(db, 'watches', {
        id,
        folder_id: folder,
        frequency,
        options: '{}',
        enabled: 1,
        next_run_at: 5000,
        error: '',
        created_at: 1234,
      })
    insertRow(db, 'updates', {
      id: 'u1',
      collection_ids: '[]',
      options: '{}',
      origin: 'watch',
      watch_id: 'w2',
    })

    migrateRest(db)

    expect(
      db.$client
        .prepare(
          'SELECT id, every_count, every_unit, time_zone, anchor_at, next_run_at FROM watches ORDER BY id',
        )
        .all(),
    ).toEqual(
      [
        ['w1', 6, 'hour'],
        ['w2', 1, 'day'],
        ['w3', 1, 'week'],
      ].map(([id, count, unit]) => ({
        id,
        every_count: count,
        every_unit: unit,
        time_zone: 'UTC',
        anchor_at: 1234,
        next_run_at: 5000,
      })),
    )
    expect(columns(db, 'watches')).not.toContain('frequency')
    // The run still names its watch.
    expect(db.$client.prepare('SELECT watch_id FROM updates').all()).toEqual([
      { watch_id: 'w2' },
    ])
    expect(indexes(db, 'watches')).toEqual([
      'watches_collection',
      'watches_due',
      'watches_folder',
    ])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('platform_thumbnails', () => {
  test('renders still queued and the pause of their type go', () => {
    const db = migratedBefore('platform_thumbnails')
    const jobs: [string, string][] = [
      ['thumbnail', 'blob-1'],
      ['download', 'asset-1'],
      ['thumbnail', 'blob-2'],
    ]
    for (const [i, [type, ref]] of jobs.entries())
      insertRow(db, 'jobs', { id: i + 1, type, ref, queue: 'download' })
    insertRow(db, 'settings', {
      key: 'jobs_control',
      value: JSON.stringify({
        paused: true,
        types: ['raw-upload', 'thumbnail'],
      }),
    })

    migrateRest(db)

    expect(
      db.$client.prepare('SELECT type, ref FROM jobs ORDER BY id').all(),
    ).toEqual([{ type: 'download', ref: 'asset-1' }])
    const control = db.$client
      .prepare(`SELECT value FROM settings WHERE key = 'jobs_control'`)
      .get()!
    expect(JSON.parse(String(control.value))).toEqual({
      paused: true,
      types: ['raw-upload'],
    })
    expect(columns(db, 'assets')).toEqual(
      expect.arrayContaining(['width', 'height', 'thumbnail_url']),
    )
  })
})

describe('web_session_devices', () => {
  test('sessions stay signed in: an id, used and made now, their expiry kept', async () => {
    const db = migratedBefore('web_session_devices')
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex')
    const soon = Date.now() + 6 * 3_600_000
    insertRow(db, 'web_sessions', { digest: digest('a'), expires_at: soon })
    insertRow(db, 'web_sessions', {
      digest: digest('b'),
      expires_at: soon + 1,
    })
    const before = Date.now()

    migrateRest(db)

    const rows = db.$client
      .prepare('SELECT * FROM web_sessions ORDER BY expires_at')
      .all()
    expect(rows).toEqual([
      expect.objectContaining({ digest: digest('a'), expires_at: soon }),
      expect.objectContaining({ digest: digest('b'), expires_at: soon + 1 }),
    ])
    for (const row of rows) {
      expect(row.id).toMatch(/^[\da-f]{32}$/)
      expect(row.created_at).toBe(row.last_used_at)
      expect(Number(row.created_at)).toBeGreaterThanOrEqual(before - 1000)
      expect(Number(row.created_at)).toBeLessThanOrEqual(Date.now())
      expect([row.method, row.origin, row.device]).toEqual([null, null, null])
    }
    expect(rows[0]!.id).not.toBe(rows[1]!.id)
    expect(indexes(db, 'web_sessions')).toEqual([
      'web_sessions_expires',
      'web_sessions_user',
    ])

    // Their next request renews them, to a full 30 days.
    const ctx = { ...testContext(), db }
    const response = await createApi({ ctx }).request('/session', {
      headers: { Cookie: `${SESSION_COOKIE}=a` },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain(
      `Max-Age=${SESSION_TTL}`,
    )
    const renewed = db.$client
      .prepare('SELECT expires_at FROM web_sessions WHERE digest = ?')
      .get(digest('a'))!
    expect(Number(renewed.expires_at)).toBeGreaterThan(
      Date.now() + SESSION_TTL * 1000 - 60_000,
    )
    await ctx.queue.stop()
  })
})

describe('handle_profiles', () => {
  test('X profiles saved by their handle take the id the library knows for them', () => {
    const db = migratedBefore('handle_profiles')
    let n = 0
    /** An account and its versions' usernames, oldest first. */
    const account = (id: string, ...usernames: string[]) => {
      insertRow(db, 'entities', {
        id: `e${id}`,
        platform: 'x',
        kind: 'x.profile',
        external_id: id,
      })
      for (const username of usernames)
        insertRow(db, 'entity_versions', {
          id: `v${id}-${username}`,
          entity_id: `e${id}`,
          content_hash: `h${++n}`,
          data: JSON.stringify({ username, name: username }),
          created_at: n,
        })
    }
    /** A saved profile, with a version rooted at `root` (a version id). */
    const profile = (id: string, externalId: string, root?: string) => {
      insertRow(db, 'collections', {
        id,
        platform: 'x',
        kind: 'profile',
        external_id: externalId,
        url: `https://x.com/${externalId.replace('handle:', '')}`,
        created_at: ++n,
      })
      insertRow(db, 'library', { collection_id: id })
      if (!root) return
      insertRow(db, 'captures', { id: `k${id}`, collection_id: id })
      insertRow(db, 'revisions', {
        id: `r${id}`,
        collection_id: id,
        capture_id: `k${id}`,
        payload: '{}',
      })
      insertRow(db, 'revision_entities', {
        revision_id: `r${id}`,
        entity_key: 'author',
        entity_version_id: root,
        is_root: 1,
      })
      db.$client
        .prepare('UPDATE collections SET current_revision = ? WHERE id = ?')
        .run(`r${id}`, id)
    }
    // Known from a list, in its own letter case.
    account('1375391728614604800', 'VueUse')
    profile('stub', 'handle:vueuse')
    // Its own version shows the account.
    account('555', 'legacy')
    profile('own', 'handle:legacy', 'v555-legacy')
    // A version rooted at an account known by handle only: as without one.
    account('handle:old', 'old')
    account('321', 'Old')
    profile('rooted', 'handle:old', 'vhandle:old-old')
    // Another collection has the id already: left for the next capture.
    account('99', 'dup')
    profile('dup', 'handle:dup')
    profile('dup-id', '99')
    // Two accounts go by it, or it went by another name since.
    account('1', 'twice')
    account('2', 'twice')
    profile('ambiguous', 'handle:twice')
    account('777', 'renamed', 'newname')
    profile('renamed', 'handle:renamed')
    // Two handles of one account: the older one takes the id.
    account('888', 'first')
    profile('older', 'handle:first', 'v888-first')
    profile('newer', 'handle:second', 'v888-first')

    migrateRest(db)

    const rows = Object.fromEntries(
      db.$client
        .prepare('SELECT id, external_id, url FROM collections ORDER BY id')
        .all()
        .map((row) => [row.id, `${row.external_id} ${row.url}`]),
    )
    expect(rows).toEqual({
      stub: '1375391728614604800 https://x.com/i/user/1375391728614604800',
      own: '555 https://x.com/i/user/555',
      dup: 'handle:dup https://x.com/dup',
      'dup-id': '99 https://x.com/99',
      ambiguous: 'handle:twice https://x.com/twice',
      renamed: 'handle:renamed https://x.com/renamed',
      rooted: '321 https://x.com/i/user/321',
      older: '888 https://x.com/i/user/888',
      newer: 'handle:second https://x.com/second',
    })
    expect(
      db.$client
        .prepare(
          'SELECT external_id, collection_id FROM collection_identity_aliases ORDER BY external_id',
        )
        .all(),
    ).toEqual([
      { external_id: 'handle:first', collection_id: 'older' },
      { external_id: 'handle:legacy', collection_id: 'own' },
      { external_id: 'handle:old', collection_id: 'rooted' },
      { external_id: 'handle:vueuse', collection_id: 'stub' },
    ])
    // Which account went by a handle is read through the index.
    expect(
      db.$client
        .prepare(
          `EXPLAIN QUERY PLAN SELECT v.entity_id FROM entity_versions v
           WHERE lower(v.data ->> '$.username') = ?
             AND v.data ->> '$.username' IS NOT NULL`,
        )
        .all('vueuse')
        .map((row) => String(row.detail))
        .join('\n'),
    ).toContain('entity_versions_username')
  })
})

describe('folder_filter_tz', () => {
  test('folders saved with time_zone say tz, and nothing else changes', () => {
    const db = migratedBefore('folder_filter_tz')
    const filters = {
      zoned: 'saved_within=7d&sort=saved&time_zone=Asia%2FTokyo',
      first: 'time_zone=UTC',
      // A search for the words is no key.
      words: 'q=time_zone%3DUTC',
      plain: 'media_type=image',
    }
    for (const [id, filter] of Object.entries(filters))
      insertRow(db, 'folders', {
        id,
        name: id,
        filter,
        created_at: 1,
        updated_at: 1,
      })
    migrateRest(db, 'folder_queries')
    expect(
      Object.fromEntries(
        db.$client
          .prepare('SELECT id, filter FROM folders')
          .all()
          .map((row) => [row.id, row.filter]),
      ),
    ).toEqual({
      zoned: 'saved_within=7d&sort=saved&tz=Asia%2FTokyo',
      first: 'tz=UTC',
      words: 'q=time_zone%3DUTC',
      plain: 'media_type=image',
    })
  })
})

describe('folder_queries', () => {
  test('every folder’s filter becomes the query that says the same', () => {
    const db = migratedBefore('folder_queries')
    const red = '0193b6e0-0000-7000-8000-00000000000a'
    const blue = '0193b6e0-0000-7000-8000-00000000000b'
    const post = '0193b6e0-0000-7000-8000-00000000000c'
    const filters = {
      empty: '',
      words: 'q=cat+OR+-dog+%23cats+from%3Ax+say%22hi%22',
      kinds:
        'entity_type=x.post%2Cx.profile%2Cinstagram.post&media_type=image%2Ctext',
      mine: `author=x%2Fx.profile%2F1&author=x%2Fx.profile%2F2&tag=${red}%2C${blue}&tag_mode=all&not_tag=${post}`,
      some: `tag=${red}%2C${blue}&visibility=private&sensitive=not_contains&post_type=quote&source_state=deleted&related_to=${post}`,
      follows:
        'rel=mutual&rel_of=x%2Fx.profile%2F2&rel_of=x%2Fx.profile%2F1&rel_min=1',
      dates:
        'saved_from=2026-11-01T00%3A00%3A00%2B09%3A00&saved_before=2026-11-02T00%3A00%3A00.000Z&order=asc&sort=saved',
      recent: 'saved_within=7d&tz=Asia%2FTokyo&sort=published',
      // A zone without a relative date meant nothing.
      zoneless: 'tz=Asia%2FTokyo',
    }
    for (const [id, filter] of Object.entries(filters))
      insertRow(db, 'folders', {
        id,
        name: id,
        filter,
        created_at: 1,
        updated_at: 1,
      })
    migrateRest(db)
    expect(columns(db, 'folders')).toEqual([
      'id',
      'name',
      'created_at',
      'updated_at',
      'query',
      'sort',
      'order',
      'tz',
    ])
    const rows = db.$client
      .prepare('SELECT id, query, sort, "order", tz FROM folders')
      .all()
    expect(Object.fromEntries(rows.map(({ id, ...row }) => [id, row]))).toEqual(
      {
        empty: { query: '', sort: '', order: '', tz: '' },
        words: {
          query: 'cat "OR" "-dog" "#cats" "from:x" "say""hi"""',
          sort: '',
          order: '',
          tz: '',
        },
        kinds: {
          query:
            '((platform:instagram type:post) OR platform:x) (has:image OR -has:media)',
          sort: '',
          order: '',
          tz: '',
        },
        mine: {
          query: `(from:x/x.profile/1 OR from:x/x.profile/2) tag:${red} tag:${blue} -tag:${post}`,
          sort: '',
          order: '',
          tz: '',
        },
        some: {
          query: `protected:yes sensitive:no (tag:${red} OR tag:${blue}) related:${post} is:quote state:deleted`,
          sort: '',
          order: '',
          tz: '',
        },
        follows: {
          query: 'rel:mutual:1:x/x.profile/1,x/x.profile/2',
          sort: '',
          order: '',
          tz: '',
        },
        dates: {
          query:
            'saved-since:2026-10-31T15:00:00.000Z saved-until:2026-11-02T00:00:00.000Z',
          sort: 'saved',
          order: 'asc',
          tz: '',
        },
        recent: {
          query: 'saved:7d',
          sort: 'published',
          order: '',
          tz: 'Asia/Tokyo',
        },
        zoneless: { query: '', sort: '', order: '', tz: '' },
      },
    )
  })
})

describe('users', () => {
  const ORIGIN = 'https://midden.test'
  const sha = (value: string) =>
    createHash('sha256').update(value).digest('hex')
  const UUID7 =
    /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

  test('the owner becomes the one admin, and every session, passkey and token is theirs and still works', async () => {
    const db = migratedBefore('users')
    const now = Date.now()
    const earliest = now - 10 * 86_400_000
    insertRow(db, 'web_sessions', {
      digest: sha('cookie'),
      id: 's1',
      expires_at: now + 86_400_000,
      created_at: earliest + 1000,
      last_used_at: now,
      method: 'passkey',
      origin: ORIGIN,
      device: 'Safari · macOS',
    })
    const authenticator = softAuthenticator()
    insertRow(db, 'passkeys', {
      id: 'p1',
      credential_id: authenticator.id,
      rp_id: 'midden.test',
      name: 'Mac',
      public_key: authenticator.publicKey,
      transports: '["internal"]',
      created_at: earliest,
    })
    insertRow(db, 'api_tokens', {
      id: 't1',
      digest: sha('mdn_ro_old'),
      label: 'dev',
      permission: 'ro',
      created_at: earliest + 2000,
    })
    insertRow(db, 'api_token_usage', {
      token_id: 't1',
      day: '2026-11-20',
      endpoint: 'GET /agent/v1/posts',
      count: 7,
    })
    insertRow(db, 'passkey_tokens', {
      digest: sha('L'.repeat(43)),
      origin: ORIGIN,
      expires_at: now + 600_000,
    })

    migrateRest(db)

    const users = db.$client.prepare('SELECT * FROM users').all()
    expect(users).toEqual([
      {
        id: expect.stringMatching(UUID7),
        name: '管理员',
        role: 'admin',
        // `midden-owner`, the handle every passkey so far was made with.
        webauthn_id: Buffer.from('midden-owner').toString('base64url'),
        created_at: earliest,
        revoked_at: null,
      },
    ])
    const admin = users[0]!.id
    for (const table of ['web_sessions', 'passkeys', 'api_tokens'])
      expect([
        table,
        db.$client.prepare(`SELECT user_id FROM ${table}`).all(),
      ]).toEqual([table, [{ user_id: admin }]])
    expect(
      db.$client.prepare('SELECT * FROM web_sessions').get(),
    ).toMatchObject({
      digest: sha('cookie'),
      id: 's1',
      method: 'passkey',
      device: 'Safari · macOS',
    })
    expect(db.$client.prepare('SELECT * FROM api_token_usage').all()).toEqual([
      {
        token_id: 't1',
        day: '2026-11-20',
        endpoint: 'GET /agent/v1/posts',
        count: 7,
      },
    ])
    expect(indexes(db, 'passkeys')).toEqual(['passkeys_rp', 'passkeys_user'])
    expect(indexes(db, 'api_tokens')).toEqual(['api_tokens_user'])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // One admin, ever.
    expect(() =>
      insertRow(db, 'users', {
        id: 'u2',
        name: 'x',
        role: 'admin',
        webauthn_id: 'x',
      }),
    ).toThrow(/UNIQUE/)
    // A token's usage still goes with it.
    db.$client.exec(`DELETE FROM api_tokens WHERE id = 't1'`)
    expect(db.$client.prepare('SELECT * FROM api_token_usage').all()).toEqual(
      [],
    )
    insertRow(db, 'api_tokens', {
      id: 't1',
      digest: sha('mdn_ro_old'),
      user_id: admin,
      label: 'dev',
      permission: 'ro',
      created_at: earliest + 2000,
    })

    // The cookie, the passkey, the token and the link all work.
    const ctx = { ...testContext(), db }
    const app = createApi({ ctx, webAppUrl: `${ORIGIN}/app/` })
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect(
      (
        await app.request('/session', {
          headers: { Cookie: `${SESSION_COOKIE}=cookie` },
        })
      ).status,
    ).toBe(204)
    expect(
      (
        await app.request('/tags', {
          headers: { Authorization: 'Bearer mdn_ro_old' },
        })
      ).status,
    ).toBe(200)
    const options = (await (
      await post('/auth/passkey/options', {})
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    const signedIn = await post('/auth/passkey', {
      response: authenticator.get(options, ORIGIN, 'midden.test'),
    })
    expect(signedIn.status).toBe(204)
    expect(signedIn.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
    expect(
      (await post('/auth/passkey/register/options', { token: 'L'.repeat(43) }))
        .status,
    ).toBe(200)
    await ctx.queue.stop()
  })

  test('a new database has the admin alone, joined now', () => {
    const before = Date.now()
    const db = openDatabase(':memory:')
    const users = db.$client.prepare('SELECT * FROM users').all()
    expect(users).toEqual([
      expect.objectContaining({
        role: 'admin',
        name: '管理员',
        webauthn_id: 'bWlkZGVuLW93bmVy',
      }),
    ])
    expect(Number(users[0]!.created_at)).toBeGreaterThanOrEqual(before - 1000)
  })
})
