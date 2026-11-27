import { describe, expect, it } from 'vitest'
import { APIError } from '../api'
import { useStale } from './useStale'

/** A read whose answers the test hands out one by one. */
function reads<T>() {
  const waiting: { resolve: (v: T) => void; reject: (e: unknown) => void }[] =
    []
  const read = () =>
    new Promise<T>((resolve, reject) => waiting.push({ resolve, reject }))
  return { read, waiting }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useStale', () => {
  it('is pending only until the first answer', async () => {
    const { read, waiting } = reads<number>()
    const s = useStale(read)
    expect(s.pending.value).toBe(true)
    void s.load()
    expect(s.loading.value).toBe(true)
    waiting[0]!.resolve(1)
    await settle()
    expect(s.data.value).toBe(1)
    expect(s.pending.value).toBe(false)
    expect(s.loading.value).toBe(false)
  })

  it('keeps showing the data while it reads again, and when that fails', async () => {
    const { read, waiting } = reads<number>()
    const s = useStale(read)
    void s.load()
    waiting[0]!.resolve(1)
    await settle()
    void s.load()
    // Reading again: the old answer stays, nothing is pending.
    expect(s.data.value).toBe(1)
    expect(s.pending.value).toBe(false)
    waiting[1]!.reject(new APIError(503, '服务暂时不可用'))
    await settle()
    expect(s.data.value).toBe(1)
    expect(s.error.value).toBe('服务暂时不可用')
    // The next good answer clears the error.
    void s.load()
    waiting[2]!.resolve(2)
    await settle()
    expect(s.data.value).toBe(2)
    expect(s.error.value).toBe('')
  })

  it('is not pending once the first read failed, so the error shows', async () => {
    const { read, waiting } = reads<number>()
    const s = useStale(read)
    void s.load()
    waiting[0]!.reject(new APIError(500, '出错了'))
    await settle()
    expect(s.pending.value).toBe(false)
    expect(s.error.value).toBe('出错了')
  })

  it('drops an answer that a newer read overtook', async () => {
    const { read, waiting } = reads<number>()
    const s = useStale(read)
    void s.load()
    void s.load()
    waiting[1]!.resolve(2)
    await settle()
    waiting[0]!.resolve(1)
    await settle()
    expect(s.data.value).toBe(2)
  })
})
