import { describe, expect, it } from 'vitest'
import { date } from './presentation'
import { deviceName, lastUsed, sessionDetails } from './sessions'
import type { WebSession } from './api'

const at = (local: string) => new Date(local).getTime()

describe('已登录的设备', () => {
  it('says when it was last used by local day', () => {
    const now = at('2026-11-27T09:00')
    expect(lastUsed(new Date(at('2026-11-27T00:10')).toISOString(), now)).toBe(
      '今天',
    )
    expect(lastUsed(new Date(at('2026-11-26T23:50')).toISOString(), now)).toBe(
      '昨天',
    )
    expect(lastUsed(new Date(at('2026-11-24T12:00')).toISOString(), now)).toBe(
      '3天前',
    )
  })

  it('reads a session: domain, how, last used, signed in', () => {
    const now = at('2026-11-27T09:00')
    const session: WebSession = {
      id: 's1',
      current: false,
      method: 'telegram',
      origin: 'https://midden.test',
      device: 'Telegram · iOS',
      created_at: '2026-11-01T08:00:00.000Z',
      last_used_at: new Date(at('2026-11-25T10:00')).toISOString(),
      expires_at: '2026-12-25T10:00:00.000Z',
    }
    expect(deviceName(session)).toBe('Telegram · iOS')
    expect(sessionDetails(session, now)).toBe(
      `midden.test · Telegram Mini App · 最近使用：2天前 · 登录于 ${date(session.created_at)}`,
    )
    // This one is in use now; from before the device list, nothing known.
    expect(
      sessionDetails(
        { ...session, current: true, method: null, origin: null, device: null },
        now,
      ),
    ).toBe(`登录于 ${date(session.created_at)}`)
    expect(deviceName({ device: null })).toBe('未知设备')
  })
})
