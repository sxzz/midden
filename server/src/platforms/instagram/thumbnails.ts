import type { Node } from './client.ts'

// Instagram lists each image in several sizes: `image_versions2.candidates`
// (url, width, height; the API's form) or `display_resources` (src,
// config_width, config_height; the web's). They usually run 1080, 750,
// 640, 480, 320 and 240 wide in the image's proportions, sometimes beside
// square or 4:5 crops for the profile grid. A video's candidates are its
// cover. Addresses are signed and expire, so the thumbnail is fetched with
// the original, at capture time.

/** The narrowest image width a content thumbnail may have. */
export const THUMBNAIL_WIDTH = 400
/** An avatar is shown at most 96 px wide. */
export const AVATAR_THUMBNAIL_WIDTH = 200

interface Candidate {
  url: string
  width: number
  height: number
}

const size = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Every sized rendition of a node's image, of either form. */
export function imageCandidates(node: Node): Candidate[] {
  const out: Candidate[] = []
  for (const c of node.image_versions2?.candidates ?? [])
    if (typeof c?.url === 'string' && c.url)
      out.push({ url: c.url, width: size(c.width), height: size(c.height) })
  for (const c of node.display_resources ?? [])
    if (typeof c?.src === 'string' && c.src)
      out.push({
        url: c.src,
        width: size(c.config_width),
        height: size(c.config_height),
      })
  return out.filter((c) => c.width && c.height)
}

/** Within 2 %, so rounding to whole pixels still matches; crops do not. */
function sameShape(a: Candidate, ratio: number): boolean {
  return Math.abs(a.width / a.height / ratio - 1) < 0.02
}

/**
 * The thumbnail of a post's image or video: the narrowest rendition at
 * least `THUMBNAIL_WIDTH` wide in the media's own proportions. An image
 * with nothing smaller than itself stands for itself (undefined). A video
 * takes the narrowest cover of that width, or else its largest cover, of
 * its proportions where one is; undefined without any.
 */
export function mediaThumbnail(
  node: Node,
  kind: 'image' | 'video',
  original: { url: string; width?: number; height?: number },
): string | undefined {
  const all = imageCandidates(node)
  const ratio =
    original.width && original.height ? original.width / original.height : 0
  const shaped = ratio ? all.filter((c) => sameShape(c, ratio)) : all
  const pool = kind === 'video' && !shaped.length ? all : shaped
  const byWidth = pool.toSorted((a, b) => a.width - b.width)
  if (kind === 'video')
    return (byWidth.find((c) => c.width >= THUMBNAIL_WIDTH) ?? byWidth.at(-1))
      ?.url
  const widest = original.width || byWidth.at(-1)?.width || 0
  return byWidth.find(
    (c) =>
      c.width >= THUMBNAIL_WIDTH && c.width < widest && c.url !== original.url,
  )?.url
}

/**
 * An avatar's thumbnail: the narrowest of `hd_profile_pic_versions` at
 * least `AVATAR_THUMBNAIL_WIDTH` wide and narrower than the avatar, or
 * else the 150 px `profile_pic_url`; undefined when that is the avatar.
 */
export function avatarThumbnail(
  user: Node,
  avatar: string,
): string | undefined {
  const widest = size(user.hd_profile_pic_url_info?.width)
  const versions: Candidate[] = (user.hd_profile_pic_versions ?? [])
    .filter((v: Node) => typeof v?.url === 'string' && v.url)
    .map((v: Node) => ({ url: v.url, width: size(v.width), height: 0 }))
  const version = versions
    .filter(
      (v) =>
        v.width >= AVATAR_THUMBNAIL_WIDTH &&
        v.url !== avatar &&
        (!widest || v.width < widest),
    )
    .toSorted((a, b) => a.width - b.width)[0]
  if (version) return version.url
  const small = user.profile_pic_url
  return typeof small === 'string' && small && small !== avatar
    ? small
    : undefined
}
