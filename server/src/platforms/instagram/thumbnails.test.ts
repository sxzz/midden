import { expect, test } from 'vitest'
import { Visibility } from '../protocol.ts'
import { postResult, profileResult } from './entities.ts'
import { shortcodeFromPk } from './resolve.ts'
import { avatarThumbnail, mediaThumbnail } from './thumbnails.ts'
import type { Node } from './client.ts'

const user = { pk: '77', username: 'fixture', full_name: 'Fixture' }
const candidates = (width: number, height: number, widths: number[]) =>
  widths.map((w) => ({
    url: `https://cdn.test/${w}.jpg`,
    width: w,
    height: Math.round((w * height) / width),
  }))

test('an image takes its narrowest size at least 400 wide, in its own proportions', () => {
  const node: Node = {
    image_versions2: {
      candidates: [
        ...candidates(1080, 1350, [1080, 750, 640, 480, 320, 240]),
        // A square crop for the profile grid.
        { url: 'https://cdn.test/crop.jpg', width: 400, height: 400 },
      ],
    },
  }
  const original = {
    url: 'https://cdn.test/1080.jpg',
    width: 1080,
    height: 1350,
  }
  expect(mediaThumbnail(node, 'image', original)).toBe(
    'https://cdn.test/480.jpg',
  )
  // The web's form of the same list.
  const web: Node = {
    display_resources: candidates(1080, 1350, [1080, 750, 640]).map((c) => ({
      src: c.url,
      config_width: c.width,
      config_height: c.height,
    })),
  }
  expect(mediaThumbnail(web, 'image', original)).toBe(
    'https://cdn.test/640.jpg',
  )
})

test('an image with nothing smaller of that width stands for itself', () => {
  const node: Node = {
    image_versions2: { candidates: candidates(480, 600, [480, 320, 240]) },
  }
  expect(
    mediaThumbnail(node, 'image', {
      url: 'https://cdn.test/480.jpg',
      width: 480,
      height: 600,
    }),
  ).toBe(undefined)
  expect(
    mediaThumbnail(
      { image_versions2: { candidates: candidates(1080, 1080, [1080]) } },
      'image',
      { url: 'https://cdn.test/1080.jpg', width: 1080, height: 1080 },
    ),
  ).toBeUndefined()
})

test('a video takes a cover: of its width where it can, else the largest; none without one', () => {
  const video = { url: 'https://cdn.test/v.mp4', width: 1080, height: 1920 }
  const covers: Node = {
    image_versions2: {
      candidates: candidates(1080, 1920, [1080, 720, 480, 240]),
    },
  }
  expect(mediaThumbnail(covers, 'video', video)).toBe(
    'https://cdn.test/480.jpg',
  )
  const small: Node = {
    image_versions2: { candidates: candidates(1080, 1920, [320, 240]) },
  }
  expect(mediaThumbnail(small, 'video', video)).toBe('https://cdn.test/320.jpg')
  // A cover of other proportions is still better than none.
  const cropped: Node = {
    image_versions2: { candidates: candidates(1080, 1080, [1080, 640]) },
  }
  expect(mediaThumbnail(cropped, 'video', video)).toBe(
    'https://cdn.test/640.jpg',
  )
  expect(mediaThumbnail({}, 'video', video)).toBeUndefined()
})

test('a post records each slide’s size and thumbnail', () => {
  const photo = (id: string): Node => ({
    pk: id,
    media_type: 1,
    image_versions2: { candidates: candidates(1080, 1350, [1080, 640, 320]) },
  })
  const node: Node = {
    pk: '2',
    code: shortcodeFromPk('2'),
    media_type: 8,
    user,
    caption: { text: 'Caption' },
    carousel_media: [
      photo('3'),
      {
        pk: '4',
        media_type: 2,
        video_versions: [
          {
            url: 'https://cdn.test/v.mp4',
            width: 720,
            height: 1280,
            type: 101,
          },
        ],
        image_versions2: { candidates: candidates(720, 1280, [720, 480]) },
      },
    ],
  }
  const result = postResult(node, '2', Visibility.VISIBILITY_PRIVATE)
  expect(
    result.resources
      .filter((r) => !r.purpose)
      .map(({ kind, width, height, thumbnailUrl }) => ({
        kind,
        width,
        height,
        thumbnailUrl,
      })),
  ).toEqual([
    {
      kind: 'image',
      width: 1080,
      height: 1350,
      thumbnailUrl: 'https://cdn.test/640.jpg',
    },
    {
      kind: 'video',
      width: 720,
      height: 1280,
      thumbnailUrl: 'https://cdn.test/480.jpg',
    },
  ])
})

test('an avatar takes the narrowest HD version from 200 wide, else the plain picture', () => {
  const hd = {
    ...user,
    hd_profile_pic_url_info: { url: 'https://cdn.test/hd.jpg', width: 1080 },
    hd_profile_pic_versions: [
      { url: 'https://cdn.test/640.jpg', width: 640, height: 640 },
      { url: 'https://cdn.test/320.jpg', width: 320, height: 320 },
    ],
    profile_pic_url: 'https://cdn.test/150.jpg',
  }
  expect(avatarThumbnail(hd, 'https://cdn.test/hd.jpg')).toBe(
    'https://cdn.test/320.jpg',
  )
  const avatar = profileResult(hd, 'fixture', Visibility.VISIBILITY_PRIVATE)
    .resources[0]!
  expect(avatar).toMatchObject({
    purpose: 'avatar',
    url: 'https://cdn.test/hd.jpg',
    thumbnailUrl: 'https://cdn.test/320.jpg',
  })
  expect(
    avatarThumbnail(
      {
        ...user,
        profile_pic_url_hd: 'https://cdn.test/hd.jpg',
        profile_pic_url: 'https://cdn.test/150.jpg',
      },
      'https://cdn.test/hd.jpg',
    ),
  ).toBe('https://cdn.test/150.jpg')
  // Only the plain picture: it stands for itself.
  expect(
    avatarThumbnail(
      { ...user, profile_pic_url: 'https://cdn.test/150.jpg' },
      'https://cdn.test/150.jpg',
    ),
  ).toBeUndefined()
})
