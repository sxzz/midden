import { call, client, errorText } from './api'
import type { Options } from './capture-options'

/**
 * Submit links to capture, one request each, as the 采集 page and the
 * rail's 抓取 do. What failed comes back to stay in the box, with a line
 * saying how it went.
 */
export async function submitLinks(urls: string[], options: Options) {
  const failed: string[] = []
  let reason = ''
  for (const url of urls) {
    try {
      await call(
        client.captures.$post(
          { json: { url, options } },
          { headers: { 'Idempotency-Key': crypto.randomUUID() } },
        ),
      )
    } catch (e) {
      failed.push(url)
      reason ||= errorText(e)
    }
  }
  const sent = urls.length - failed.length
  return {
    sent,
    failed,
    notice: failed.length
      ? {
          text: `${sent ? `已提交 ${sent} 条，` : ''}${failed.length} 条未提交：${reason}`,
          failed: true,
        }
      : { text: `已提交 ${sent} 条。` },
  }
}
