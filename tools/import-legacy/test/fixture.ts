// A small legacy database built from the Go migrations, with one of each
// thing the import converts.
import { Buffer } from 'node:buffer'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import type { Connection } from '../src/postgres.ts'

const MIGRATIONS = new URL('legacy-migrations/', import.meta.url)

/** Create the old schema by running the Go service's migrations in order. */
export async function migrateLegacy(connection: Connection): Promise<void> {
  const client = new pg.Client(connection)
  await client.connect()
  try {
    const files = (await readdir(MIGRATIONS))
      .filter((name) => name.endsWith('.sql'))
      .toSorted()
    for (const file of files) {
      await client.query('BEGIN')
      await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'))
      await client.query('COMMIT')
    }
  } finally {
    await client.end()
  }
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const ids = {
  tenant: id(1),
  // Another user of the old service; only the owner's library is imported.
  otherTenant: id(2),
  othersOnly: id(13),
  otherCapture: id(24),
  otherSubmission: id(94),
  otherTag: id(111),
  post: id(10),
  profile: id(11),
  unsaved: id(12),
  capture: id(20),
  reuse: id(21),
  interrupted: id(22),
  profileCapture: id(23),
  revision: id(30),
  profileRevision: id(31),
  postEntity: id(40),
  authorEntity: id(41),
  orphanEntity: id(42),
  postVersion: id(50),
  authorVersion: id(51),
  // Equal to authorVersion except for the JSON Schema it was stored with.
  authorVersionAgain: id(52),
  orphanVersion: id(53),
  image: id(60),
  video: id(61),
  avatar: id(62),
  imageObject: id(70),
  videoObject: id(71),
  avatarObject: id(72),
  pendingAsset: id(80),
  submission: id(90),
  pageSubmission: id(91),
  morePage: id(92),
  interruptedSubmission: id(93),
  runningBatch: id(100),
  doneBatch: id(101),
  tag: id(110),
  connection: id(120),
  credential: id(121),
}

export const CREDENTIAL = 'session-cookie=1'

export interface Media {
  image: Buffer
  video: Buffer
  avatar: Buffer
}

export const SMALL_MEDIA: Media = {
  image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  // An `ftyp` box, enough for the new service to sniff video/mp4.
  video: Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom\0\0\0\0isommp42', 'latin1'),
  ]),
  avatar: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]),
}

export interface Fixture {
  credentialKey: Buffer
  hashes: Record<keyof Media, string>
}

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex')

/** Seal like Go's credentials.Vault: nonce || ciphertext || tag. */
function goSeal(key: Buffer, aad: string, plain: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

/**
 * Fill a migrated legacy database and write the bucket objects under
 * `bucket/objects/`. `platform` picks the entity types: `fake` matches the
 * server's fake test platform, `x` renders like real X posts.
 */
export async function seedLegacy(
  connection: Connection,
  bucket: string,
  options: { media?: Media; platform?: 'fake' | 'x' } = {},
): Promise<Fixture> {
  const media = options.media ?? SMALL_MEDIA
  const platform = options.platform ?? 'fake'
  const x = platform === 'x'
  const postUrl = x
    ? 'https://x.com/author/status/100'
    : 'https://fake.test/p/100'
  const profileUrl = x ? 'https://x.com/author' : 'https://fake.test/u/7'
  const postType = `${platform}.post`
  const profileType = `${platform}.profile`
  const postData = x
    ? {
        text: 'hello from the old service',
        published_at: '2026-01-02T03:04:05Z',
      }
    : { text: 'hello' }
  const profileData = x
    ? { username: 'author', name: 'Author', metadata: { protected: false } }
    : { name: 'Author' }
  const metricPaths = x
    ? {
        'x.post': ['/replies', '/reposts', '/likes', '/bookmarks', '/quotes'],
        'x.profile': ['/metadata/followers'],
      }
    : { 'fake.post': ['/likes'] }
  const credentialKey = randomBytes(32)
  const hashes = {
    image: sha256(media.image),
    video: sha256(media.video),
    avatar: sha256(media.avatar),
  }

  await mkdir(path.join(bucket, 'objects'), { recursive: true })
  await writeFile(path.join(bucket, 'objects', ids.imageObject), media.image)
  await writeFile(path.join(bucket, 'objects', ids.videoObject), media.video)
  // Older objects carry the tenant in their key.
  await mkdir(path.join(bucket, ids.tenant, 'objects'), { recursive: true })
  await writeFile(
    path.join(bucket, ids.tenant, 'objects', ids.avatarObject),
    media.avatar,
  )

  const schemaV1 = { type: 'object', title: 'v1' }
  const schemaV2 = { type: 'object', title: 'v2' }
  const postGraph = {
    root: 'post',
    entities: [
      {
        id: ids.authorEntity,
        version_id: ids.authorVersion,
        key: 'author',
        type: profileType,
        external_id: '7',
        data: profileData,
        schema: schemaV1,
        resource_indices: [2],
        context_only: true,
      },
      {
        id: ids.postEntity,
        version_id: ids.postVersion,
        key: 'post',
        type: postType,
        external_id: '100',
        data: postData,
        schema: schemaV1,
        resource_indices: [0, 1],
      },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  }
  const postPayload = {
    author_name: 'Author',
    published_at: '2026-01-02T03:04:05Z',
    graph: postGraph,
    media_sensitive: [false, true, false],
    media_descriptions: ['an image', '', ''],
    text: postData.text,
    text_kind: 'plain',
    warnings: [],
    adapter_version: '1',
    metrics: { [`${postType}/100`]: { '/likes': 5 } },
    metric_paths: metricPaths,
  }
  const profilePayload = {
    author_name: 'Author',
    summary: 'Author profile',
    graph: {
      root: 'profile',
      entities: [
        {
          id: ids.authorEntity,
          version_id: ids.authorVersionAgain,
          key: 'profile',
          type: profileType,
          external_id: '7',
          data: profileData,
          schema: schemaV2,
          resource_indices: [0],
        },
      ],
      relations: [],
    },
    media_sensitive: [false],
    media_descriptions: [''],
    text: '',
    text_kind: 'plain',
    warnings: [],
    adapter_version: '2',
  }

  const client = new pg.Client(connection)
  await client.connect()
  const q = (text: string, values: unknown[] = []) => client.query(text, values)
  try {
    await q('BEGIN')
    await q('INSERT INTO tenants (id) VALUES ($1)', [ids.tenant])
    await q(
      `INSERT INTO collections (id, platform, kind, external_id, url, provider_id,
          unreferenced_at, created_at, observed_at)
        VALUES ($1, $4, 'post', '100', $5, 'public', NULL, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'),
          ($2, $4, 'profile', '7', $6, 'public', NULL, '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z'),
          ($3, $4, 'post', '200', $7, 'public', '2026-01-04T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [
        ids.post,
        ids.profile,
        ids.unsaved,
        platform,
        postUrl,
        profileUrl,
        postUrl.replace('100', '200'),
      ],
    )
    await q(
      `INSERT INTO collection_identity_aliases
          (platform, kind, object_scope, external_id, collection_id)
        VALUES ($1, 'profile', '', 'handle:author', $2)`,
      [platform, ids.profile],
    )
    await q(
      `INSERT INTO tenant_collections
          (tenant_id, collection_id, provider_id, adapter_id, note, created_at)
        VALUES ($1, $2, 'public', $4, 'a note', '2026-01-01T00:00:01Z'),
          ($1, $3, 'public', $4, '', '2026-01-01T00:00:02Z')`,
      [ids.tenant, ids.post, ids.profile, platform],
    )
    await q(`INSERT INTO tags (tenant_id, id, name) VALUES ($1, $2, 'art')`, [
      ids.tenant,
      ids.tag,
    ])
    await q(
      `INSERT INTO collection_tags (tenant_id, collection_id, tag_id)
        VALUES ($1, $2, $3)`,
      [ids.tenant, ids.post, ids.tag],
    )

    const capture = (
      captureId: string,
      collection: string,
      state: string,
      extra: Record<string, unknown> = {},
    ) => {
      const columns: Record<string, unknown> = {
        id: captureId,
        tenant_id: ids.tenant,
        collection_id: collection,
        provider_id: 'public',
        adapter_id: platform,
        scope: 'public',
        state,
        adapter_version: '1',
        ...extra,
      }
      const names = Object.keys(columns)
      return q(
        `INSERT INTO captures (${names.join(', ')})
          VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(columns),
      )
    }
    await capture(ids.capture, ids.post, 'complete', {
      created_at: '2026-01-02T00:00:00Z',
      finished_at: '2026-01-02T00:00:10Z',
      metrics: JSON.stringify({ [`${postType}/100`]: { '/likes': 5 } }),
      related_targets: 'null',
    })
    await capture(ids.reuse, ids.post, 'complete', {
      created_at: '2026-01-03T00:00:00Z',
      finished_at: '2026-01-03T00:00:10Z',
      metrics: JSON.stringify({ [`${postType}/100`]: { '/likes': 8 } }),
    })
    await capture(ids.interrupted, ids.post, 'downloading', {
      created_at: '2026-01-04T00:00:00Z',
      payload: JSON.stringify(postPayload),
    })
    await capture(ids.profileCapture, ids.profile, 'complete', {
      created_at: '2026-01-02T00:00:00Z',
      finished_at: '2026-01-02T00:00:20Z',
      is_collection: true,
      page_size: 100,
      next_page_cursor: 'cursor-2',
      max_batch_size: 100,
      related_targets: JSON.stringify([
        {
          url: postUrl,
          refresh_after_seconds: 3600,
          updated_at: '2026-01-02T03:04:05Z',
          prefetch: Buffer.from('prefetched').toString('base64'),
          published_at: '2026-01-02T03:04:05Z',
          media_types: ['image', 'video'],
          post_type: 'post',
        },
        { url: postUrl.replace('100', '200') },
      ]),
    })

    await q(
      `INSERT INTO revisions (id, collection_id, capture_id, content_hash,
          payload, content_bytes, created_at)
        VALUES ($1, $2, $3, 'legacy-hash', $4, $5, '2026-01-02T00:00:10Z'),
          ($6, $7, $8, 'legacy-hash-2', $9, $10, '2026-01-02T00:00:20Z')`,
      [
        ids.revision,
        ids.post,
        ids.capture,
        JSON.stringify(postPayload),
        Buffer.byteLength(JSON.stringify(postPayload)),
        ids.profileRevision,
        ids.profile,
        ids.profileCapture,
        JSON.stringify(profilePayload),
        Buffer.byteLength(JSON.stringify(profilePayload)),
      ],
    )
    await q(`UPDATE captures SET revision_id = $1 WHERE id IN ($2, $3)`, [
      ids.revision,
      ids.capture,
      ids.reuse,
    ])
    await q(`UPDATE captures SET revision_id = $1 WHERE id = $2`, [
      ids.profileRevision,
      ids.profileCapture,
    ])
    await q(`UPDATE collections SET current_revision = $1 WHERE id = $2`, [
      ids.revision,
      ids.post,
    ])
    await q(`UPDATE collections SET current_revision = $1 WHERE id = $2`, [
      ids.profileRevision,
      ids.profile,
    ])

    await q(
      `INSERT INTO entities (id, platform, kind, external_id) VALUES
        ($1, $4, $5, '100'), ($2, $4, $6, '7'), ($3, $4, $5, '999')`,
      [
        ids.postEntity,
        ids.authorEntity,
        ids.orphanEntity,
        platform,
        postType,
        profileType,
      ],
    )
    const version = (
      versionId: string,
      entity: string,
      data: unknown,
      schema: unknown,
      at: string,
    ) =>
      q(
        `INSERT INTO entity_versions (id, entity_id, content_hash, data, schema, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          versionId,
          entity,
          `legacy-${versionId}`,
          JSON.stringify(data),
          JSON.stringify(schema),
          at,
        ],
      )
    await version(
      ids.postVersion,
      ids.postEntity,
      postData,
      schemaV1,
      '2026-01-02T00:00:10Z',
    )
    await version(
      ids.authorVersion,
      ids.authorEntity,
      profileData,
      schemaV1,
      '2026-01-02T00:00:10Z',
    )
    await version(
      ids.authorVersionAgain,
      ids.authorEntity,
      profileData,
      schemaV2,
      '2026-01-02T00:00:20Z',
    )
    await version(
      ids.orphanVersion,
      ids.orphanEntity,
      { text: 'gone' },
      schemaV1,
      '2026-01-01T00:00:00Z',
    )
    await q(
      `INSERT INTO revision_entities (revision_id, entity_key, entity_version_id, is_root)
        VALUES ($1, 'post', $2, true), ($1, 'author', $3, false), ($4, 'profile', $5, true)`,
      [
        ids.revision,
        ids.postVersion,
        ids.authorVersion,
        ids.profileRevision,
        ids.authorVersionAgain,
      ],
    )
    await q(
      `INSERT INTO entity_relations (revision_id, source_key, target_key, kind)
        VALUES ($1, 'post', 'author', 'authored_by')`,
      [ids.revision],
    )

    await q(
      `INSERT INTO objects (id, object_key, state) VALUES
        ($1, $4, 'attached'), ($2, $5, 'attached'), ($3, $6, 'attached')`,
      [
        ids.imageObject,
        ids.videoObject,
        ids.avatarObject,
        `objects/${ids.imageObject}`,
        `objects/${ids.videoObject}`,
        `${ids.tenant}/objects/${ids.avatarObject}`,
      ],
    )
    await q(
      `INSERT INTO blobs (id, hash, object_key, size, mime) VALUES
        ($1, $4, $7, $10, 'image/jpeg'), ($2, $5, $8, $11, 'video/mp4'),
        ($3, $6, $9, $12, 'image/jpeg')`,
      [
        ids.image,
        ids.video,
        ids.avatar,
        hashes.image,
        hashes.video,
        hashes.avatar,
        `objects/${ids.imageObject}`,
        `objects/${ids.videoObject}`,
        `${ids.tenant}/objects/${ids.avatarObject}`,
        media.image.length,
        media.video.length,
        media.avatar.length,
      ],
    )
    await q(
      `INSERT INTO blob_thumbnails (blob_id, state, error) VALUES ($1, 'failed', 'no')`,
      [ids.video],
    )
    const asset = (
      captureId: string,
      position: number,
      kind: string,
      blob: string | null,
      extra: Record<string, unknown> = {},
    ) => {
      const columns: Record<string, unknown> = {
        capture_id: captureId,
        position,
        source_url: `https://media.fake.test/${captureId}/${position}`,
        kind,
        state: blob ? 'ready' : 'pending',
        blob_id: blob,
        ...extra,
      }
      const names = Object.keys(columns)
      return q(
        `INSERT INTO assets (${names.join(', ')})
          VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(columns),
      )
    }
    for (const captureId of [ids.capture, ids.reuse]) {
      await asset(captureId, 0, 'image', ids.image, { alt_text: 'an image' })
      await asset(captureId, 1, 'video', ids.video, { sensitive: true })
      await asset(captureId, 2, 'image', ids.avatar, { purpose: 'avatar' })
    }
    await asset(ids.profileCapture, 0, 'image', ids.avatar, {
      purpose: 'avatar',
    })
    await asset(ids.interrupted, 0, 'image', null, { id: ids.pendingAsset })

    for (const captureId of [ids.capture, ids.interrupted]) {
      const body = Buffer.from(JSON.stringify({ capture: captureId }))
      await q(
        `INSERT INTO source_responses (tenant_id, capture_id, position, visibility,
            body, content_type, source_url, sha256, size)
          VALUES ($1, $2, 0, 'private', $3, 'application/json', 'https://api.fake.test/', $4, $5)`,
        [ids.tenant, captureId, body, sha256(body), body.length],
      )
    }

    const submission = (
      submissionId: string,
      captureId: string,
      key: string,
      extra: Record<string, unknown> = {},
    ) => {
      const columns: Record<string, unknown> = {
        id: submissionId,
        tenant_id: ids.tenant,
        capture_id: captureId,
        idem_key: key,
        fingerprint: `fp-${key}`,
        input: postUrl,
        ...extra,
      }
      const names = Object.keys(columns)
      return q(
        `INSERT INTO submissions (${names.join(', ')})
          VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(columns),
      )
    }
    await submission(ids.submission, ids.capture, 'web:1', {
      chat_id: '42',
      message_id: 7,
      state: 'done',
      created_at: '2026-01-02T00:00:00Z',
    })
    await submission(ids.pageSubmission, ids.profileCapture, 'web:2', {
      input: profileUrl,
      related_state: 'complete',
      related_provider: 'public',
      related_adapter: platform,
      related_source_collection: ids.profile,
      capture_options: JSON.stringify({
        media_only: true,
        max_posts: 50,
        since: '2026-01-01T00:00:00Z',
      }),
      created_at: '2026-01-02T00:00:00Z',
    })
    await submission(
      ids.morePage,
      ids.profileCapture,
      `more:${ids.pageSubmission}`,
      {
        input: profileUrl,
        related_state: 'pending',
        related_provider: 'public',
        related_adapter: platform,
        created_at: '2026-01-02T00:01:00Z',
      },
    )
    await q('UPDATE submissions SET next_submission = $1 WHERE id = $2', [
      ids.morePage,
      ids.pageSubmission,
    ])
    await submission(ids.interruptedSubmission, ids.interrupted, 'web:3', {
      created_at: '2026-01-04T00:00:00Z',
    })

    await q(
      `INSERT INTO refresh_batches (tenant_id, id, collection_ids, position,
          reused, capture_ids, state, created_at)
        VALUES ($1, $2, $4::uuid[], 1, 1, $5::uuid[], 'running', '2026-01-03T00:00:00Z'),
          ($1, $3, $6::uuid[], 1, 1, $7::uuid[], 'complete', '2026-01-03T00:00:00Z')`,
      [
        ids.tenant,
        ids.runningBatch,
        ids.doneBatch,
        [ids.post, ids.profile],
        [ids.reuse],
        [ids.post],
        [ids.reuse],
      ],
    )

    await q(
      `INSERT INTO account_credentials (id, tenant_id, ciphertext) VALUES ($1, $2, $3)`,
      [
        ids.credential,
        ids.tenant,
        goSeal(credentialKey, `${ids.tenant}:${ids.credential}`, CREDENTIAL),
      ],
    )
    await q(
      `INSERT INTO connections (id, tenant_id, adapter_id, provider_id, name,
          account_id, username, state, credential_ref, revision)
        VALUES ($1, $2, $3, 'session', 'me', 'acc', 'me', 'ready', $4, 3)`,
      [ids.connection, ids.tenant, platform, ids.credential],
    )
    await q(
      `INSERT INTO tenant_preferences (tenant_id, adapter_id, default_connection_id)
        VALUES ($1, $2, $3)`,
      [ids.tenant, platform, ids.connection],
    )
    await q(
      `INSERT INTO web_sessions (digest, tenant_id) VALUES ('digest', $1)`,
      [ids.tenant],
    )
    await q('INSERT INTO tenants (id) VALUES ($1)', [ids.otherTenant])
    await q(
      `INSERT INTO collections (id, platform, kind, external_id, url, provider_id)
        VALUES ($1, $2, 'post', '300', $3, 'public')`,
      [ids.othersOnly, platform, postUrl.replace('100', '300')],
    )
    await q(
      `INSERT INTO tenant_collections
          (tenant_id, collection_id, provider_id, adapter_id, note)
        VALUES ($1, $2, 'public', $4, 'theirs'), ($1, $3, 'public', $4, '')`,
      [ids.otherTenant, ids.post, ids.othersOnly, platform],
    )
    await q(`INSERT INTO tags (tenant_id, id, name) VALUES ($1, $2, 'art')`, [
      ids.otherTenant,
      ids.otherTag,
    ])
    await q(
      `INSERT INTO collection_tags (tenant_id, collection_id, tag_id)
        VALUES ($1, $2, $3)`,
      [ids.otherTenant, ids.post, ids.otherTag],
    )
    await capture(ids.otherCapture, ids.othersOnly, 'failed', {
      tenant_id: ids.otherTenant,
      error: 'unavailable',
      finished_at: '2026-01-02T00:00:00Z',
    })
    await submission(ids.otherSubmission, ids.otherCapture, 'web:1', {
      tenant_id: ids.otherTenant,
    })
    await q(
      `INSERT INTO tenant_preferences (tenant_id, adapter_id) VALUES ($1, $2)`,
      [ids.otherTenant, platform],
    )
    await q('COMMIT')
  } finally {
    await client.end()
  }
  return { credentialKey, hashes }
}
