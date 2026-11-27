// The load test's stand-ins, built inside each server process: a platform
// whose profiles list 100 posts a page, each with an image (some a video
// too); media downloads served from memory, every URL distinct bytes; and
// the media and raw buckets on the orchestrator's fake S3 servers.
//
// Environment: BENCH_S3_MEDIA, BENCH_S3_RAW (fake S3 endpoints), BENCH_IMAGE,
// BENCH_THUMBNAIL, BENCH_VIDEO (sample files), BENCH_PAGE_MS, BENCH_FETCH_MS, BENCH_MEDIA_MS
// (upstream latency of a timeline page, a post without prefetch, a media
// file).
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { BucketBlobStore } from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { cachePurge } from '#blob/purge.ts'
import { S3Bucket } from '#blob/s3.ts'
import { MediaSigner } from '#blob/signer.ts'
import { r2Credentials } from '#cloudflare.ts'
import { deriveKey } from '#crypto.ts'
import { Platforms } from '#platforms/registry.ts'
import { RawStore } from '#raw/store.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import {
  FAKE_PUBLIC,
  FAKE_TOKEN,
  FAKE_TOKEN_ID,
  FAKE_ZONE,
} from '#testing/fake-s3.ts'
import type { Logger } from '#log.ts'
import type { FetchRequest, FetchResponse } from '#platforms/protocol.ts'

export const PAGE = 100

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

/** Deterministic pseudo-random numbers, so runs are comparable. */
function random(seed: number) {
  let state = seed % 2_147_483_648
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function seedOf(text: string): number {
  let hash = 7
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

/** JSON text of about `size` bytes that compresses like API responses. */
function json(next: () => number, size: number): string {
  const items: string[] = []
  let length = 0
  while (length < size) {
    const item = `{"id":"${Math.floor(next() * 1e15)}","text":"${next().toString(36).repeat(3)}","likes":${Math.floor(next() * 1e5)}}`
    items.push(item)
    length += item.length + 1
  }
  return `[${items.join(',')}]`
}

const source = (body: string) => ({
  body: Buffer.from(body),
  contentType: 'application/json',
  sourceUrl: 'https://api.test/graphql',
  visibility: 1,
})

function profileGraph(id: string) {
  return {
    root: 'profile',
    entities: [
      {
        key: 'profile',
        type: 'fake.profile',
        externalId: id,
        dataJson: Buffer.from(
          JSON.stringify({
            name: `Bench ${id}`,
            metadata: { followers: 1000, following: 100 },
          }),
        ),
        resourceIndices: [],
        contextOnly: false,
      },
    ],
    relations: [],
  }
}

function respond(
  req: FetchRequest,
  media: string,
): Promise<Partial<FetchResponse>> | Partial<FetchResponse> {
  const next = random(seedOf(req.externalId + req.pageCursor))
  if (req.kind === 'profile') {
    const page = Number(req.pageCursor || 0)
    return sleep(Number(env('BENCH_PAGE_MS', '400'))).then(() => ({
      text: `Bench ${req.externalId}`,
      textKind: 'profile',
      graph: profileGraph(req.externalId),
      relatedTargets: Array.from({ length: PAGE }, (_, i) => ({
        url: `https://fake.test/p/b${req.externalId}_${page}_${i}`,
        refreshAfterSeconds: 0,
        updatedAt: '',
        publishedAt: new Date(
          Date.UTC(2026, 10, 1) - (page * PAGE + i) * 3_600_000,
        ).toISOString(),
        mediaTypes: ['image'],
        postType: 'post',
        prefetch: Buffer.from(json(next, 2500 + next() * 2500)),
        listedAt: '',
        pinned: false,
      })),
      nextPageCursor: String(page + 1),
      sourceResponses: [source(json(next, 60_000 + next() * 60_000))],
    }))
  }
  const id = req.externalId
  const video = seedOf(id) % 10 === 0
  const author = id.split('_', 1)[0]!.slice(1)
  const resources = [
    {
      url: `${media}/img/${id}.jpg`,
      kind: 'image',
      immutableKey: `img:${id}`,
      width: 1280,
      height: 960,
      thumbnailUrl: `${media}/thumb/img/${id}.jpg`,
      altText: '',
      sensitive: false,
      purpose: '',
    },
    ...(video
      ? [
          {
            url: `${media}/vid/${id}.mp4`,
            kind: 'video',
            immutableKey: `vid:${id}`,
            width: 640,
            height: 360,
            thumbnailUrl: `${media}/thumb/vid/${id}.jpg`,
            altText: '',
            sensitive: false,
            purpose: '',
          },
        ]
      : []),
  ]
  // With facets (BENCH_FACETS=1), posts carry hashtags, a link in a third
  // of them and a mention in a quarter, as `library/facets.ts` reads them.
  const facets = env('BENCH_FACETS', '') === '1'
  const seed = seedOf(id)
  const lead = facets
    ? `#bench${seed % 40} #tag${seed % 7} ${seed % 3 === 0 ? `https://site${seed % 25}.example/p/${id} ` : ''}`
    : ''
  const mention = facets && seed % 4 === 0 ? `u${seed % 30}` : undefined
  const response: Partial<FetchResponse> = {
    text: lead + json(next, 300 + next() * 600),
    resources,
    graph: {
      root: 'post',
      entities: [
        {
          key: 'post',
          type: 'fake.post',
          externalId: id,
          dataJson: Buffer.from(
            JSON.stringify({
              text: lead + json(next, 200 + next() * 400),
              likes: Math.floor(next() * 1e4),
            }),
          ),
          resourceIndices: resources.map((_, i) => i),
          contextOnly: false,
        },
        {
          key: 'author',
          type: 'fake.profile',
          externalId: author,
          dataJson: Buffer.from(JSON.stringify({ name: `Bench ${author}` })),
          resourceIndices: [],
          contextOnly: true,
        },
        ...(mention
          ? [
              {
                key: 'mention',
                type: 'fake.profile',
                externalId: `handle:${mention}`,
                dataJson: Buffer.from(
                  JSON.stringify({ username: mention, name: mention }),
                ),
                resourceIndices: [],
                contextOnly: true,
              },
            ]
          : []),
      ],
      relations: [
        { source: 'post', target: 'author', type: 'authored_by' },
        ...(mention
          ? [{ source: 'post', target: 'mention', type: 'mentions' }]
          : []),
      ],
    },
    sourceResponses: [source(json(next, 3000 + next() * 5000))],
  }
  // A timeline's posts come with their data (the prefetch), as X's do.
  if (req.prefetch.length) return response
  return sleep(Number(env('BENCH_FETCH_MS', '150'))).then(() => response)
}

const s3 = (endpoint: string, bucket: string) =>
  new S3Bucket({
    endpoint,
    bucket,
    ...r2Credentials(FAKE_TOKEN_ID, FAKE_TOKEN),
    retryDelayMs: 100,
  })

/** The overrides `runtime/run.ts` takes (`RuntimeOverrides`). */
export function benchOverrides(
  config: { secretKey: string; mediaDir: string },
  logger: Logger,
) {
  const mediaEndpoint = env('BENCH_S3_MEDIA')
  const media = 'https://media.bench'
  const image = readFileSync(env('BENCH_IMAGE'))
  const thumbnail = readFileSync(env('BENCH_THUMBNAIL'))
  const video = readFileSync(env('BENCH_VIDEO'))
  const mediaMs = Number(env('BENCH_MEDIA_MS', '60'))
  const signer = new MediaSigner({
    secret: deriveKey(config.secretKey, 'media-url'),
  })
  return {
    platforms: new Platforms([
      fakePlatform({ current: (req) => respond(req, media) }),
    ]),
    blobs: new BucketBlobStore({
      local: new FsBlobStore(config.mediaDir, signer),
      bucket: s3(mediaEndpoint, 'media'),
      publicUrl: FAKE_PUBLIC,
      purge: cachePurge({
        zoneId: FAKE_ZONE,
        token: FAKE_TOKEN,
        logger,
        apiBase: `${mediaEndpoint}/client/v4`,
      }),
    }),
    raw: new RawStore(s3(env('BENCH_S3_RAW'), 'raw')),
    // Media bytes from memory: the sample with the URL after its end, which
    // decoders ignore, so every file is a distinct blob.
    fetch: async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      await sleep(mediaMs)
      const kind = url.includes('/thumb/')
        ? 'thumbnail'
        : url.includes('/vid/')
          ? 'video'
          : 'image'
      return new Response(
        Buffer.concat([{ image, thumbnail, video }[kind], Buffer.from(url)]),
        {
          headers: {
            'content-type': kind === 'video' ? 'video/mp4' : 'image/jpeg',
          },
        },
      )
    },
  }
}
