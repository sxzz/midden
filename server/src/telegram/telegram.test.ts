import { describe, expect, test } from 'vitest'
import { deliveryParts } from './parts.ts'
import {
  collectionMessage,
  failureReason,
  groupKeyboard,
  progressMessage,
  webRoute,
} from './presentation.ts'
import { addressedText, chunks, messageLinks, summaryLine } from './text.ts'
import type { AssetView, CollectionView } from '#library/views.ts'

const asset = (id: string, extra: Partial<AssetView> = {}): AssetView => ({
  id,
  position: 0,
  state: 'ready',
  sensitive: false,
  size: 10,
  mime: 'image/png',
  ...extra,
})

const collection = (patch: Partial<CollectionView> = {}): CollectionView => ({
  id: '01a20000-0000-7000-8000-000000000001',
  url: 'https://x.com/a/status/1',
  external_id: '1',
  provider_id: 'fxtwitter',
  visibility: 'public',
  revision_id: 'r',
  text: 'hello',
  text_kind: 'plain',
  adapter_version: '1',
  author_name: 'Author',
  warnings: [],
  assets: [],
  observed_at: '',
  created_at: '',
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '1', data: {} },
      {
        key: 'author',
        type: 'x.profile',
        external_id: '7',
        data: { username: 'someone' },
      },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
  ...patch,
})

describe('text', () => {
  test('chunks never split a surrogate pair', () => {
    const parts = chunks('a😀b😀', 2)
    expect(parts.join('')).toBe('a😀b😀')
    expect(parts.every((p) => p.length <= 2)).toBe(true)
  })

  test('links come from entities and bare words, once each', () => {
    expect(
      messageLinks({
        text: '看 https://x.com/a/status/1 和 链接',
        entities: [
          { type: 'url', offset: 2, length: 24 },
          { type: 'text_link', offset: 29, length: 2, url: 'https://x.com/b' },
        ],
      }),
    ).toEqual(['https://x.com/a/status/1', 'https://x.com/b'])
  })

  test('groups need an @mention of this bot', () => {
    const at = (
      text: string,
      offset: number,
      length: number,
      type = 'mention',
    ) =>
      addressedText(
        { text, entities: [{ type, offset, length } as never] },
        'OurBot',
      )
    expect(at('@ourbot https://x', 0, 7)).toEqual({
      addressed: true,
      text: 'https://x',
    })
    expect(at('@OurBotExtra https://x', 0, 12).addressed).toBe(false)
    expect(at('/usage@OurBot', 0, 13, 'bot_command').addressed).toBe(true)
    expect(at('/usage', 0, 6, 'bot_command').addressed).toBe(false)
    expect(at('😀 @OurBot x', 3, 7).addressed).toBe(true)
  })

  test('list lines are cut by code point, keeping media markers', () => {
    expect(summaryLine(`${'字'.repeat(120)}[图片][视频]`)).toBe(
      `${'字'.repeat(91)}…[图片][视频]`,
    )
    expect(summaryLine('  ')).toBe('无文字内容')
  })
})

describe('presentation', () => {
  test('a post message: id in code, author linked, body quoted', () => {
    const message = collectionMessage(collection(), 'complete', {
      webAppUrl: 'https://midden.test/app/?v=1#old',
    })
    const id = collection().id
    expect(message.text).toBe(`${id}\n\nAuthor：\nhello`)
    expect(message.entities).toEqual([
      { type: 'code', offset: 0, length: id.length },
      {
        type: 'text_link',
        offset: id.length + 2,
        length: 6,
        url: 'https://x.com/someone',
      },
      { type: 'blockquote', offset: id.length + 10, length: 5 },
    ])
    expect(message.keyboard.at(-1)).toEqual([
      {
        text: '在小程序中打开',
        web_app: { url: `https://midden.test/app/?v=1#/collection/${id}` },
      },
    ])
  })

  test('an empty body shows only the author; reasons are translated once', () => {
    const message = collectionMessage(
      collection({
        text: '',
        warnings: ['post not found or deleted'],
        assets: [
          asset('a', { state: 'failed', error: 'post not found or deleted' }),
        ],
      }),
      'partial',
    )
    expect(message.text).toBe(
      `${collection().id}\n\nAuthor\n\n部分内容未保存\n\n未完整保存原因：帖子不存在或已删除`,
    )
  })

  test('mini app buttons need https and never appear in groups', () => {
    expect(webRoute('http://x.test/app/', 'a', '/b')).toBeUndefined()
    expect(
      groupKeyboard([
        [{ text: 'list', callback_data: '/list' }],
        [{ text: 'app', web_app: { url: 'https://x' } }],
        [{ text: 'show', callback_data: '/show x' }],
      ]),
    ).toEqual([[{ text: 'show', callback_data: '/show x' }]])
  })

  test('progress controls follow the collection state', () => {
    const base = {
      submissionId: 's',
      collectionId: 'c',
      url: 'https://x.com/a',
      input: 'https://x.com/a',
      rootState: 'complete',
      rootError: '',
      total: 5,
      complete: 2,
      partial: 2,
      failed: 1,
      done: false,
      stopped: false,
      next: 'n',
      maxBatch: 1000,
      pageError: false,
      reasons: [{ reason: 'storage quota exceeded', count: 2 }],
    }
    const labels = (p: typeof base) =>
      progressMessage(p, { group: true })
        .keyboard!.flat()
        .map((b) => b.text)
    expect(labels(base)).toEqual([
      '在 X 查看主页',
      '中止',
      '查看已保存资料',
      '收藏列表',
    ])
    expect(labels({ ...base, done: true })).toEqual([
      '在 X 查看主页',
      '抓取更多',
      '抓取1000条',
      '查看已保存资料',
      '收藏列表',
    ])
    expect(progressMessage(base, { group: true }).text).toContain(
      '内容不完整 2 · 失败 1 · 进行中 0',
    )
    expect(progressMessage(base, { group: true }).text).toContain(
      '存储配额不足（2 条）',
    )
    expect(failureReason(' unknown ')).toBe('unknown')
  })
})

describe('deliveryParts', () => {
  test('one item carries the caption and then the keyboard', () => {
    const text = 'x'.repeat(5000)
    const parts = deliveryParts(
      text,
      [{ type: 'bold', offset: 1000, length: 100 }],
      [asset('a')],
    )
    expect(parts.map((p) => p.kind)).toEqual([
      'media',
      'buttons',
      'text',
      'text',
    ])
    const caption = parts[0] as { caption: string; entities: unknown[] }
    expect(caption.caption).toHaveLength(1024)
    expect(caption.entities).toEqual([
      { type: 'bold', offset: 1000, length: 24 },
    ])
    expect((parts[2] as { entities: unknown[] }).entities).toEqual([
      { type: 'bold', offset: 0, length: 76 },
    ])
  })

  test('albums hold ten, never mix webm, and carry no caption', () => {
    const many = [
      ...Array.from({ length: 11 }, (_, i) => asset(`p${i}`)),
      asset('w', { mime: 'video/webm' }),
    ]
    const parts = deliveryParts('text', [], many)
    expect(
      parts.map((p) => (p.kind === 'media' ? p.assets.length : p.kind)),
    ).toEqual([10, 1, 1, 'text'])
  })

  test('oversized files become a notice', () => {
    const parts = deliveryParts('t', [], [asset('big', { size: 50_000_001 })])
    expect(parts).toEqual([
      {
        kind: 'text',
        text: 't\n\n文件超过 Telegram 大小限制，请在网页查看。',
        entities: [],
      },
    ])
  })
})
