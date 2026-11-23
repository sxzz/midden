import { getCollection } from '#library/read.ts'
import { isProfile, type Keyboard, type Rendered } from './presentation.ts'
import type { BatchProgress } from '#capture/batches.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { MemberProgress } from '#capture/records.ts'

const SCHEME = /^https?:\/\//
const ACTIVE_SHOWN = 5
const NAME_LENGTH = 32

/** Non-zero `<label> <n>` pairs joined by ` · `. */
function counts(pairs: [string, number][]): string {
  return pairs
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join(' · ')
}

function posts(members: MemberProgress, done: boolean): string {
  if (done)
    return counts([
      ['已保存', members.complete],
      ['不完整', members.partial],
      ['失败', members.failed],
    ])
  if (members.total <= 0) return ''
  const finished = members.complete + members.partial + members.failed
  const of = Math.max(members.total, finished + members.pending)
  const detail = counts([
    ['抓取中', members.pending],
    ['已保存', members.complete],
    ['不完整', members.partial],
    ['失败', members.failed],
  ])
  return `${finished}/${of}${detail ? ` · ${detail}` : ''}`
}

function itemName(
  ctx: CaptureContext,
  collectionId: string,
  url: string,
): string {
  let name = ''
  try {
    const view = getCollection(ctx, collectionId)
    const profile = isProfile(view)
      ? (view.graph?.entities.find((e) => e.key === view.graph!.root)?.data as
          Record<string, unknown> | undefined)
      : undefined
    name =
      (typeof profile?.name === 'string' ? profile.name.trim() : '') ||
      view.author_name?.trim() ||
      ''
  } catch {}
  return name || url.replace(SCHEME, '')
}

function cut(value: string, max: number): string {
  const chars = [...value]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

/** The message following a refresh batch started from the web. */
export function batchMessage(ctx: CaptureContext, b: BatchProgress): Rendered {
  const memberLine = posts(b.members, b.members.done)
  const summary = memberLine ? `\n帖子：${memberLine}` : ''
  const fetched = Math.max(b.complete - b.reused, 0)
  if (b.state === 'failed' && b.done)
    return {
      text: `批量更新已中止：采集服务不可用\n已提交 ${b.submitted}/${b.total}${summary}`,
      entities: [],
    }
  if (!b.done) {
    const detail = counts([
      ['抓取中', b.running],
      ['已抓取', fetched],
      ['无变化', b.reused],
      ['失败', b.failed],
    ])
    let text = `批量更新中…\n已提交 ${b.submitted}/${b.total}${detail ? ` · ${detail}` : ''}${summary}`
    const keyboard: Keyboard = []
    if (b.active.length) {
      text += '\n\n进行中：'
      for (const item of b.active.slice(0, ACTIVE_SHOWN)) {
        const name = itemName(ctx, item.collectionId, item.url)
        const parts = [
          ...(item.running ? ['抓取中'] : []),
          ...(item.members && posts(item.members, item.members.done)
            ? [`帖子 ${posts(item.members, item.members.done)}`]
            : []),
        ]
        text += `\n• ${name}\n  ${parts.join(' · ') || '提交帖子中'}`
        keyboard.push([{ text: cut(name, NAME_LENGTH), url: item.url }])
      }
      if (b.active.length > ACTIVE_SHOWN)
        text += `\n另有 ${b.active.length - ACTIVE_SHOWN} 项`
    }
    return { text, entities: [], keyboard }
  }
  const detail = counts([
    ['已抓取', fetched],
    ['无变化', b.reused],
    ['不完整', b.partial],
    ['失败', b.failed],
    ['无法更新', b.rejected],
  ])
  return {
    text: `批量更新完成，共 ${b.total} 项${detail ? `\n${detail}` : ''}${summary}`,
    entities: [],
    keyboard:
      b.retryable > 0
        ? [
            [
              {
                text: `重试失败的帖子（${b.retryable}）`,
                callback_data: `/batch_retry ${b.id}`,
              },
            ],
          ]
        : [],
  }
}
