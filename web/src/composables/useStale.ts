import { computed, shallowRef } from 'vue'
import { errorText } from '../api'

/**
 * Data read again and again (on show, on a poll) without ever blanking it:
 * a read keeps what is shown until its answer replaces it, a failed read
 * keeps it too and says why, and only the very first read, with nothing to
 * show yet, is `pending` (for a skeleton). An answer that arrives after a
 * newer read started is dropped.
 */
export function useStale<T>(read: () => Promise<T>) {
  const data = shallowRef<T>()
  const error = shallowRef('')
  const loading = shallowRef(false)
  let run = 0
  async function load() {
    const current = ++run
    loading.value = true
    try {
      const value = await read()
      if (current !== run) return
      data.value = value
      error.value = ''
    } catch (e) {
      if (current === run) error.value = errorText(e)
    } finally {
      if (current === run) loading.value = false
    }
  }
  /** Nothing to show yet, and nothing has failed: the skeleton's time. */
  const pending = computed(() => data.value === undefined && !error.value)
  return { data, error, loading, pending, load }
}
