import { eq } from 'drizzle-orm'
import { removedMedia } from '#db/schema.ts'
import { canonicalJson, sha256Hex } from './json.ts'
import type { Executor } from '#db/client.ts'

// Instagram's immutable key ends in the rendition picked (type, size and
// bitrate) after the media id; a later capture may pick another one.
const INSTAGRAM_RENDITION = /^(instagram:media:.+)(?::[^:]*){3}$/

/** The platform's identity of the media, without the rendition picked. */
function identity(immutableKey: string): string {
  return INSTAGRAM_RENDITION.exec(immutableKey)?.[1] ?? immutableKey
}

/**
 * What names one media item across captures and collections (a repost or a
 * quote lists the same one): the platform's media identity, or the address
 * where the platform gave none. Never empty.
 */
export function mediaKey(
  platform: string,
  resource: { immutableKey: string; url: string },
): string {
  return resource.immutableKey
    ? sha256Hex(canonicalJson([platform, identity(resource.immutableKey)]))
    : `url:${resource.url}`
}

/** Whether the owner removed this media (已移除), so it is not fetched. */
export function isRemoved(db: Executor, key: string): boolean {
  return !!db
    .select({ key: removedMedia.mediaKey })
    .from(removedMedia)
    .where(eq(removedMedia.mediaKey, key))
    .get()
}
