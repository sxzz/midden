// Test helpers for the library read side: captures run through the real
// pipeline against the fake platform.
import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { captureHandlers } from '#capture/handlers.ts'
import { submit, type SubmitInput } from '#capture/submit.ts'
import { captures } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, type FakeFetch } from '#testing/fake-platform.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Entity, EntityGraph, Resource } from '#platforms/protocol.ts'

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

/** A context whose media downloads return distinct JPEG bytes per path. */
export function libraryContext(fetch: FakeFetch) {
  const handle = { current: fetch }
  const ctx = testContext({
    platforms: [fakePlatform(handle)],
    handlers: captureHandlers,
    fetch: (input) =>
      Promise.resolve(
        new Response(
          Buffer.concat([JPEG, Buffer.from(new URL(String(input)).pathname)]),
        ),
      ),
  })
  ctx.queue.start()
  return { ctx, handle }
}

/** Submit and wait for everything to settle; the capture as stored. */
export async function capture(
  ctx: CaptureContext,
  input: string | SubmitInput,
) {
  const job = submit(ctx, typeof input === 'string' ? { url: input } : input)
  await ctx.queue.drain()
  return ctx.db.select().from(captures).where(eq(captures.id, job.id)).get()!
}

export function entity(
  key: string,
  type: string,
  externalId: string,
  data: object = {},
  resourceIndices: number[] = [],
): Entity {
  return {
    key,
    type,
    externalId,
    dataJson: Buffer.from(JSON.stringify(data)),
    resourceIndices,
    contextOnly: key !== 'root',
  }
}

/** A graph rooted at `root`, with [source, type, target] relations. */
export function graph(
  entities: Entity[],
  ...relations: [string, string, string][]
): EntityGraph {
  return {
    root: 'root',
    entities,
    relations: relations.map(([source, type, target]) => ({
      source,
      type,
      target,
    })),
  }
}

export function image(path: string, extra: Partial<Resource> = {}): Resource {
  return {
    url: `https://m.test/${path}`,
    kind: 'image',
    immutableKey: '',
    altText: '',
    sensitive: false,
    purpose: '',
    ...extra,
  }
}
