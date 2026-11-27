import { expect, test } from 'vitest'
import { Visibility } from '../protocol.ts'
import { preferOriginalAvatars } from './avatar.ts'
import { normalize } from './provider.ts'
import {
  avatarThumbnail,
  bannerThumbnail,
  mediaThumbnail,
} from './thumbnails.ts'

const media = 'https://pbs.twimg.com/media/HHmqKLibgAAy4BT'

test('an image larger than `small` takes it, as WebP; a smaller one stands for itself', () => {
  for (const url of [`${media}.jpg?name=orig`, `${media}?format=png&name=orig`])
    expect(mediaThumbnail(url, { width: 1200, height: 1378 })).toBe(
      `${media}?format=webp&name=small`,
    )
  // Of unknown size: `small` never enlarges, so it is safe.
  expect(mediaThumbnail(`${media}.jpg?name=orig`, {})).toBe(
    `${media}?format=webp&name=small`,
  )
  expect(
    mediaThumbnail(`${media}.jpg?name=orig`, { width: 680, height: 400 }),
  ).toBeUndefined()
  // Off the CDN there are no sizes to ask for.
  expect(
    mediaThumbnail('https://media.test/a.jpg', { width: 4000, height: 3000 }),
  ).toBeUndefined()
})

test("a video's poster takes `small` without its extension, which would ignore it", () => {
  const poster =
    'https://pbs.twimg.com/amplify_video_thumb/2113693950116577280/img/t6nDZxNu8uaLlVRD'
  expect(
    mediaThumbnail(`${poster}.jpg`, { width: 1080, height: 1080 }, true),
  ).toBe(`${poster}?format=webp&name=small`)
  // A small poster still is the only still there is.
  expect(
    mediaThumbnail(`${poster}.jpg`, { width: 320, height: 320 }, true),
  ).toBe(`${poster}?format=webp&name=small`)
  for (const path of [
    'ext_tw_video_thumb/1/pu/img/a.jpg',
    'tweet_video_thumb/a.jpg',
  ])
    expect(mediaThumbnail(`https://pbs.twimg.com/${path}`, {}, true)).toMatch(
      /\?format=webp&name=small$/,
    )
  expect(mediaThumbnail('https://media.test/poster.jpg', {}, true)).toBe(
    'https://media.test/poster.jpg',
  )
})

test('avatars take the 200 px size; banners 600 by 200', () => {
  const avatar =
    'https://pbs.twimg.com/profile_images/1747761429581901824/FtPuS1WS'
  for (const url of [`${avatar}.jpg`, `${avatar}_400x400.jpg`])
    expect(avatarThumbnail(url)).toBe(`${avatar}_200x200.jpg`)
  expect(avatarThumbnail(`${avatar}.png`)).toBe(`${avatar}_200x200.png`)
  for (const small of ['_normal', '_bigger', '_200x200'])
    expect(avatarThumbnail(`${avatar}${small}.jpg`)).toBeUndefined()
  expect(
    avatarThumbnail(
      'https://abs.twimg.com/sticky/default_profile_images/default_profile.png',
    ),
  ).toBeUndefined()

  const banner =
    'https://pbs.twimg.com/profile_banners/1716664662954274816/1751068510'
  for (const url of [banner, `${banner}/1500x500`])
    expect(bannerThumbnail(url)).toBe(`${banner}/600x200`)
  expect(bannerThumbnail('https://media.test/banner')).toBeUndefined()
})

test('a post records each media item’s size and thumbnail', () => {
  const result = normalize(
    {
      type: 'status',
      id: '1',
      text: 'hi',
      media: {
        all: [
          {
            type: 'photo',
            id: '10',
            url: `${media}.jpg?name=orig`,
            width: 2048,
            height: 1536,
          },
          {
            type: 'photo',
            id: '11',
            url: 'https://pbs.twimg.com/media/Small.jpg?name=orig',
            width: 600,
            height: 400,
          },
          {
            type: 'video',
            id: '12',
            url: 'https://video.twimg.com/v/1.mp4',
            thumbnail_url:
              'https://pbs.twimg.com/amplify_video_thumb/12/img/p.jpg',
            width: 1920,
            height: 1080,
            formats: [
              { container: 'mp4', url: 'https://video.twimg.com/v/1.mp4' },
            ],
          },
          {
            type: 'gif',
            id: '13',
            url: 'https://video.twimg.com/tweet_video/g.mp4',
            width: 0,
          },
        ],
      },
    },
    '1',
    'fxtwitter',
    Visibility.VISIBILITY_PUBLIC,
  )
  expect(
    result.resources.map(({ width, height, thumbnailUrl }) => ({
      width,
      height,
      thumbnailUrl,
    })),
  ).toEqual([
    {
      width: 2048,
      height: 1536,
      thumbnailUrl: `${media}?format=webp&name=small`,
    },
    { width: 600, height: 400, thumbnailUrl: undefined },
    {
      width: 1920,
      height: 1080,
      thumbnailUrl:
        'https://pbs.twimg.com/amplify_video_thumb/12/img/p?format=webp&name=small',
    },
    // Neither a size nor a poster: no still, boxed as unknown.
    { width: undefined, height: undefined, thumbnailUrl: undefined },
  ])
})

test('an avatar upgraded to its original size gets the 200 px thumbnail', async () => {
  const avatar = 'https://pbs.twimg.com/profile_images/1/a'
  const result = normalize(
    {
      type: 'status',
      id: '1',
      text: 'hi',
      media: { all: [] },
      author: { id: '2', screen_name: 'a', avatar_url: `${avatar}_normal.jpg` },
    },
    '1',
    'fxtwitter',
    Visibility.VISIBILITY_PUBLIC,
  )
  const resource = result.resources.find((r) => r.purpose === 'avatar')!
  expect(resource.thumbnailUrl).toBeUndefined()
  await preferOriginalAvatars(
    result,
    new AbortController().signal,
    async () =>
      new Response(null, { headers: { 'content-type': 'image/jpeg' } }),
    new Map(),
  )
  expect(resource.url).toBe(`${avatar}.jpg`)
  expect(resource.thumbnailUrl).toBe(`${avatar}_200x200.jpg`)
})
