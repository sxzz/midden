// The smaller renditions X's image CDN serves, used as thumbnails. Checked
// against pbs.twimg.com: `name` is one of thumb (a 150 px square crop),
// tiny (64), 240x240, 360x360, small (680), 900x900, medium (1200), large
// (2048) and orig; all but thumb fit the image in that box, never enlarging
// it. `small` is the smallest at least 400 px on the long edge. The
// `format` parameter picks the encoding (WebP is about a third of the JPEG,
// a twentieth of a PNG), and it and `name` only take effect without an
// extension in the path: a video poster's `.jpg?name=small` is the full
// size. Profile images come in fixed sizes by suffix (_normal 48, _bigger
// 73, _200x200, _400x400, none for the upload), banners by a last path
// segment (300x100, 600x200, 1500x500 and others).

const CDN = 'pbs.twimg.com'
/** The long edge of `name=small`. */
export const SMALL_EDGE = 680
const MEDIA_PATH =
  /^\/(?:media|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//
const AVATAR =
  /^(\/profile_images\/\d+\/[^/]+?)(_normal|_bigger|_mini|_x96|_200x200|_400x400)?(\.\w+)?$/
const BANNER = /^(\/profile_banners\/\d+\/\d+)(?:\/[^/]+)?$/

function cdnURL(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      url.hostname === CDN &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url
  } catch {}
}

/**
 * The thumbnail of a post's image, or of a video by its poster: `small` as
 * WebP. None for an image already no larger than that, which stands for
 * itself; a poster off the CDN is used as it is.
 */
export function mediaThumbnail(
  image: string,
  size: { width?: number; height?: number },
  poster = false,
): string | undefined {
  const url = cdnURL(image)
  if (!url || !MEDIA_PATH.test(url.pathname)) return poster ? image : undefined
  const edge = Math.max(size.width ?? 0, size.height ?? 0)
  if (!poster && edge && edge <= SMALL_EDGE) return
  url.pathname = url.pathname.replace(/\.\w+$/, '')
  url.search = '?format=webp&name=small'
  return url.href
}

/**
 * An avatar's 200 px size, enough for the at most 96 px it is shown at;
 * none when the avatar is that size or smaller already.
 */
export function avatarThumbnail(avatar: string): string | undefined {
  const url = cdnURL(avatar)
  const match = url && AVATAR.exec(url.pathname)
  if (!url || !match) return
  const [, base, suffix, extension = ''] = match
  if (suffix && suffix !== '_400x400') return
  url.pathname = `${base}_200x200${extension}`
  return url.href
}

/** A banner's 600 by 200 size. */
export function bannerThumbnail(banner: string): string | undefined {
  const url = cdnURL(banner)
  const match = url && BANNER.exec(url.pathname)
  if (!url || !match) return
  url.pathname = `${match[1]}/600x200`
  url.search = ''
  return url.href
}
