import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Vault } from '../../../server/src/accounts/vault.ts'
import { FsBlobStore } from '../../../server/src/blob/fs-store.ts'
import { KeyedLock } from '../../../server/src/blob/locks.ts'
import { MediaSigner } from '../../../server/src/blob/signer.ts'
import { isPermanent } from '../../../server/src/capture/errors.ts'
import { revisionDigest } from '../../../server/src/capture/finalize.ts'
import { captureHandlers } from '../../../server/src/capture/handlers.ts'
import { canonicalJson, sha256Hex } from '../../../server/src/capture/json.ts'
import { submit } from '../../../server/src/capture/submit.ts'
import { deriveKey } from '../../../server/src/crypto.ts'
import { openDatabase, type Database } from '../../../server/src/db/client.ts'
import { JobQueue } from '../../../server/src/jobs/queue.ts'
import { listCollections } from '../../../server/src/library/list.ts'
import {
  getCollection,
  listRevisions,
} from '../../../server/src/library/read.ts'
import { createLogger } from '../../../server/src/log.ts'
import { Platforms } from '../../../server/src/platforms/registry.ts'
import {
  fakePlatform,
  postGraph,
} from '../../../server/src/testing/fake-platform.ts'
import { hasPostgresTools, TemporaryPostgres } from '../src/postgres.ts'
import {
  CREDENTIAL,
  ids,
  migrateLegacy,
  seedLegacy,
  SMALL_MEDIA,
  type Fixture,
} from './fixture.ts'
import type { CaptureContext } from '../../../server/src/capture/context.ts'
import type { Payload } from '../../../server/src/capture/payload.ts'

const run = promisify(execFile)
const MAIN = new URL('../src/main.ts', import.meta.url).pathname
const SECRET_KEY = 'a-new-secret-key-that-is-long-enough'

// Needs PostgreSQL's server tools, e.g. `mise exec postgres@17 -- pnpm test`.
describe.skipIf(!hasPostgresTools())('import', () => {
  let server: TemporaryPostgres
  let dir: string
  let fixture: Fixture
  let bucket: string
  let out: string

  const cli = (args: string[], env: Record<string, string> = {}) =>
    run(process.execPath, [MAIN, ...args], {
      env: { ...process.env, SECRET_KEY, ...env },
    }).then(
      (result) => ({ code: 0, ...result }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    )

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'midden-import-test-'))
    server = await TemporaryPostgres.start()
    const admin = server.connection('postgres')
    const client = new pg.Client(admin)
    await client.connect()
    await client.query('CREATE DATABASE legacy')
    await client.end()
    await migrateLegacy(server.connection('legacy'))

    // The archive layout of the old scripts/backup.sh.
    const backup = path.join(dir, 'backup')
    bucket = path.join(backup, 's3', 'monitor')
    fixture = await seedLegacy(server.connection('legacy'), bucket)
    await mkdir(path.join(backup, 'config'))
    await writeFile(
      path.join(backup, 'config', '.env'),
      `S3_BUCKET=monitor\nCREDENTIAL_KEY="${fixture.credentialKey.toString('base64')}"\n`,
    )
    await run('pg_dump', [
      '--host',
      server.dir,
      '--username',
      'postgres',
      '--format',
      'custom',
      '--file',
      path.join(backup, 'database.dump'),
      'legacy',
    ])
    await run('tar', ['-czf', path.join(dir, 'backup.tgz'), '-C', backup, '.'])

    out = path.join(dir, 'data')
    const result = await cli([
      '--backup',
      path.join(dir, 'backup.tgz'),
      '--tenant',
      ids.tenant,
      '--out',
      out,
    ])
    expect(result.stderr).toContain('Imported into')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('all hashes match')
  }, 120_000)

  afterAll(async () => {
    await server?.stop()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  function open(): { db: Database; ctx: CaptureContext } {
    const db = openDatabase(path.join(out, 'midden.db'))
    const ctx = {
      db,
      blobs: new FsBlobStore(
        path.join(out, 'media'),
        new MediaSigner({ secret: new Uint8Array(32) }),
      ),
    } as Partial<CaptureContext> as CaptureContext
    return { db, ctx }
  }

  test('the library reads like the old one', () => {
    const { db, ctx } = open()
    try {
      const page = listCollections(ctx)
      expect(page.items.map((c) => c.id).toSorted()).toEqual(
        [ids.post, ids.profile].toSorted(),
      )
      const post = getCollection(ctx, ids.post)
      expect(post.text).toBe('hello')
      expect(post.revision_id).toBe(ids.revision)
      expect(post.saved_at).toBe('2026-01-01T00:00:01.000Z')
      expect(post.assets.map((a) => [a.mime, a.state, a.sha256])).toEqual([
        ['image/jpeg', 'ready', fixture.hashes.image],
        ['video/mp4', 'ready', fixture.hashes.video],
      ])
      expect(post.assets[0].url).toMatch(/^\/media\//)
      // Payload entities no longer carry their JSON Schema.
      expect(post.graph?.entities.map((e) => 'schema' in e)).toEqual([
        false,
        false,
      ])
      const author = post.graph?.entities.find((e) => e.key === 'author')
      expect(author?.version_id).toBe(ids.authorVersion)
      expect(listRevisions(ctx, ids.post).items).toHaveLength(1)

      const note = db.$client
        .prepare('SELECT note FROM library WHERE collection_id = ?')
        .get(ids.post)
      expect(note?.note).toBe('a note')
      const tags = db.$client
        .prepare(
          'SELECT t.name FROM collection_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.collection_id = ?',
        )
        .all(ids.post)
      expect(tags).toEqual([{ name: 'art' }])
    } finally {
      db.$client.close()
    }
  })

  test('keeps only the owner library, records and settings', async () => {
    const { db } = open()
    try {
      const all = (query: string) => db.$client.prepare(query).all()
      expect(all('SELECT collection_id, note FROM library ORDER BY 1')).toEqual(
        [
          { collection_id: ids.post, note: 'a note' },
          { collection_id: ids.profile, note: '' },
        ],
      )
      expect(all('SELECT id FROM tags')).toEqual([{ id: ids.tag }])
      expect(
        all(`SELECT id FROM submissions WHERE id = '${ids.otherSubmission}'`),
      ).toEqual([])
      expect(all('SELECT adapter_id FROM account_selections')).toHaveLength(1)
      // Content stays; what only the other tenant saved awaits removal.
      const others = db.$client
        .prepare('SELECT unreferenced_at FROM collections WHERE id = ?')
        .get(ids.othersOnly)
      expect(others?.unreferenced_at).toEqual(expect.any(Number))
      const kept = db.$client
        .prepare('SELECT unreferenced_at FROM collections WHERE id = ?')
        .get(ids.post)
      expect(kept?.unreferenced_at).toBeNull()
    } finally {
      db.$client.close()
    }
    // Several tenants and no --tenant: refuse instead of guessing.
    const result = await cli(
      [
        '--database-url',
        `postgresql://postgres@localhost/legacy?host=${encodeURIComponent(server.dir)}`,
        '--objects',
        bucket,
        '--out',
        path.join(dir, 'ambiguous'),
      ],
      { CREDENTIAL_KEY: fixture.credentialKey.toString('base64') },
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('choose the owner')
  }, 60_000)

  test('media are stored by content hash', () => {
    for (const hash of Object.values(fixture.hashes))
      expect(
        existsSync(
          path.join(out, 'media', hash.slice(0, 2), hash.slice(2, 4), hash),
        ),
      ).toBe(true)
  })

  test('unfinished work is settled', () => {
    const { db } = open()
    try {
      const get = (query: string, ...values: string[]) =>
        db.$client.prepare(query).get(...values)
      expect(
        get(
          'SELECT state, error, payload FROM captures WHERE id = ?',
          ids.interrupted,
        ),
      ).toEqual({
        state: 'failed',
        error: 'capture was interrupted',
        payload: null,
      })
      expect(
        get('SELECT state, error FROM assets WHERE id = ?', ids.pendingAsset),
      ).toEqual({ state: 'failed', error: 'capture was interrupted' })
      expect(
        get(
          'SELECT count(*) AS n FROM source_responses WHERE capture_id = ?',
          ids.interrupted,
        ),
      ).toEqual({ n: 0 })
      expect(
        get(
          'SELECT related_state, related_error FROM submissions WHERE id = ?',
          ids.morePage,
        ),
      ).toEqual({
        related_state: 'failed',
        related_error: 'capture was interrupted',
      })
      expect(
        get(
          'SELECT state, collection_ids, capture_ids FROM refresh_batches WHERE id = ?',
          ids.runningBatch,
        ),
      ).toEqual({
        state: 'failed',
        collection_ids: JSON.stringify([ids.post, ids.profile]),
        capture_ids: JSON.stringify([ids.reuse]),
      })
    } finally {
      db.$client.close()
    }
  })

  test('JSON columns use the new field names', () => {
    const { db } = open()
    try {
      const targets = db.$client
        .prepare('SELECT related_targets FROM captures WHERE id = ?')
        .get(ids.profileCapture)
      expect(JSON.parse(String(targets?.related_targets))).toEqual([
        {
          url: 'https://fake.test/p/100',
          refreshAfterSeconds: 3600,
          updatedAt: '2026-01-02T03:04:05Z',
          publishedAt: '2026-01-02T03:04:05Z',
          mediaTypes: ['image', 'video'],
          postType: 'post',
          prefetch: Buffer.from('prefetched').toString('base64'),
        },
        {
          url: 'https://fake.test/p/200',
          refreshAfterSeconds: 0,
          updatedAt: '',
          publishedAt: '',
          mediaTypes: [],
          postType: '',
        },
      ])
      const options = db.$client
        .prepare('SELECT capture_options FROM submissions WHERE id = ?')
        .get(ids.pageSubmission)
      expect(JSON.parse(String(options?.capture_options))).toEqual({
        mediaOnly: true,
        maxPosts: 50,
        since: '2026-01-01T00:00:00Z',
      })
    } finally {
      db.$client.close()
    }
  })

  test('hashes follow the new algorithms', () => {
    const { db } = open()
    try {
      const versions = db.$client
        .prepare(
          'SELECT id, content_hash, data FROM entity_versions ORDER BY id',
        )
        .all()
      // The two author versions differed only by schema and merged.
      expect(versions.map((v) => v.id)).toEqual([
        ids.postVersion,
        ids.authorVersion,
      ])
      const media = (...items: [string, string, boolean][]) =>
        items.map(([hash, alt, sensitive]) => [
          '',
          hash,
          'ready',
          alt,
          sensitive,
          '',
        ])
      expect(versions[0].content_hash).toBe(
        sha256Hex(
          canonicalJson([
            { text: 'hello' },
            media(
              [fixture.hashes.image, 'an image', false],
              [fixture.hashes.video, '', true],
            ),
          ]),
        ),
      )
      const profile = db.$client
        .prepare(
          'SELECT entity_version_id FROM revision_entities WHERE revision_id = ?',
        )
        .get(ids.profileRevision)
      expect(profile?.entity_version_id).toBe(ids.authorVersion)

      const revision = db.$client
        .prepare('SELECT payload, content_hash FROM revisions WHERE id = ?')
        .get(ids.profileRevision)
      const payload = JSON.parse(String(revision?.payload)) as Payload
      expect(payload.graph?.entities[0].version_id).toBe(ids.authorVersion)
      expect(revision?.content_hash).toBe(
        revisionDigest(
          payload,
          [
            {
              position: 0,
              purpose: 'avatar',
              hash: fixture.hashes.avatar,
              altText: '',
              sensitive: false,
              state: 'ready',
              error: '',
            },
          ],
          new Set(),
          {},
        ),
      )
    } finally {
      db.$client.close()
    }
  })

  test('credentials open with the new key', () => {
    const { db } = open()
    try {
      const vault = new Vault(deriveKey(SECRET_KEY, 'credentials'))
      expect(vault.open(db, ids.credential).toString()).toBe(CREDENTIAL)
      expect(
        db.$client.prepare('SELECT * FROM account_selections').all(),
      ).toEqual([{ adapter_id: 'fake', connection_id: ids.connection }])
    } finally {
      db.$client.close()
    }
  })

  test('capturing the same content again adds no version', async () => {
    const db = openDatabase(path.join(out, 'midden.db'))
    const logger = createLogger('silent')
    const bytes: Record<string, Buffer> = {
      '/0': SMALL_MEDIA.image,
      '/1': SMALL_MEDIA.video,
      '/2': SMALL_MEDIA.avatar,
    }
    let ctx: CaptureContext | undefined
    const queue = new JobQueue({
      db,
      logger,
      handlers: captureHandlers(() => ctx!),
      concurrency: { capture: 1, download: 2, control: 1 },
      isPermanent,
    })
    ctx = {
      db,
      queue,
      logger,
      platforms: new Platforms([
        fakePlatform({
          current: () => ({
            text: 'hello',
            authorName: 'Author',
            publishedAt: '2026-01-02T03:04:05Z',
            graph: postGraph('100', { text: 'hello', likes: 9 }, undefined, {
              resourceIndices: [0, 1],
              authorResources: [2],
            }),
            resources: [
              {
                url: 'https://media.fake.test/0',
                kind: 'image',
                altText: 'an image',
              },
              {
                url: 'https://media.fake.test/1',
                kind: 'video',
                sensitive: true,
              },
              {
                url: 'https://media.fake.test/2',
                kind: 'image',
                purpose: 'avatar',
              },
            ].map((r) => ({
              altText: '',
              sensitive: false,
              purpose: '',
              immutableKey: '',
              ...r,
            })),
          }),
        }),
      ]),
      blobs: new FsBlobStore(
        path.join(out, 'media'),
        new MediaSigner({ secret: new Uint8Array(32) }),
      ),
      stagingDir: path.join(dir, 'staging'),
      openCredential: () => new Uint8Array(),
      mediaLocks: new KeyedLock(),
      fetch: (input) =>
        Promise.resolve(new Response(bytes[new URL(String(input)).pathname])),
    }
    queue.start()
    try {
      const versions = () =>
        db.$client.prepare('SELECT count(*) AS n FROM entity_versions').get()
      const before = versions()
      const job = submit(ctx, { refreshId: ids.post })
      await queue.drain()
      const capture = db.$client
        .prepare('SELECT state, error, revision_id FROM captures WHERE id = ?')
        .get(job.id)
      expect(capture).toEqual({
        state: 'complete',
        error: '',
        revision_id: ids.revision,
      })
      expect(versions()).toEqual(before)
    } finally {
      await queue.stop()
      db.$client.close()
    }
  })

  test('an existing target needs --force', async () => {
    const args = [
      '--database-url',
      `postgresql://postgres@localhost/legacy?host=${encodeURIComponent(server.dir)}`,
      '--objects',
      bucket,
      '--tenant',
      ids.tenant,
      '--out',
      out,
    ]
    const env = { CREDENTIAL_KEY: fixture.credentialKey.toString('base64') }
    const refused = await cli(args, env)
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('already exists')
    const forced = await cli([...args, '--force'], env)
    expect(forced.code).toBe(0)
  }, 60_000)

  test('a changed object fails the import', async () => {
    const copy = path.join(dir, 'bucket-bad')
    await mkdir(path.join(copy, 'objects'), { recursive: true })
    await writeFile(
      path.join(copy, 'objects', ids.imageObject),
      SMALL_MEDIA.image,
    )
    await writeFile(path.join(copy, 'objects', ids.videoObject), 'tampered')
    await mkdir(path.join(copy, ids.tenant, 'objects'), { recursive: true })
    await writeFile(
      path.join(copy, ids.tenant, 'objects', ids.avatarObject),
      SMALL_MEDIA.image,
    )
    const target = path.join(dir, 'bad')
    const result = await cli(
      [
        '--database-url',
        `postgresql://postgres@localhost/legacy?host=${encodeURIComponent(server.dir)}`,
        '--objects',
        copy,
        '--tenant',
        ids.tenant,
        '--out',
        target,
      ],
      { CREDENTIAL_KEY: fixture.credentialKey.toString('base64') },
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(`MISMATCH blob ${ids.video}`)
    // The avatar object holds the image's bytes here.
    expect(result.stdout).toContain(`MISMATCH blob ${ids.avatar}`)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.partial`)).toBe(true)
  }, 60_000)
})
