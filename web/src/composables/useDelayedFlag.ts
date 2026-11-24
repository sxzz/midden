import { onScopeDispose, shallowRef, watch } from 'vue'

/**
 * `source`, for showing progress: true only once it has held for `delay` ms,
 * and then for at least `minimum` ms, so a quick save shows nothing and a
 * slow one does not vanish the moment it lands.
 */
export function useDelayedFlag(
  source: () => boolean,
  delay = 300,
  minimum = 600,
) {
  const shown = shallowRef(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let since = 0
  watch(
    source,
    (on) => {
      clearTimeout(timer)
      if (on && !shown.value)
        timer = setTimeout(() => {
          shown.value = true
          since = Date.now()
        }, delay)
      else if (!on && shown.value)
        timer = setTimeout(
          () => (shown.value = false),
          Math.max(0, minimum - (Date.now() - since)),
        )
    },
    { immediate: true },
  )
  onScopeDispose(() => clearTimeout(timer))
  return shown
}
