import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client } from '../api'
import { shareSlug } from '../share'

/**
 * The account a graph is marked from (`viewer` in the address): any
 * account with relation data. Without the parameter, the owner's first
 * capture account that has data; `viewer=` (empty) is none. Never behind a
 * public link.
 */
export function useViewer() {
  const route = useRoute()
  const router = useRouter()
  const fallback = shallowRef('')
  /** Whether the viewer is known: given, looked up, or none to have. */
  const ready = shallowRef(false)
  const controller = new AbortController()
  onUnmounted(() => controller.abort())
  // A cached page keeps its viewer while another page is shown.
  const page = route.name
  let last: string | undefined
  const given = computed(() => {
    if (route.name !== page) return last
    const value = route.query.viewer
    last =
      value === undefined
        ? undefined
        : ((Array.isArray(value) ? value[0] : value) ?? '')
    return last
  })
  let asked = false
  watch(
    given,
    async (value) => {
      if (value !== undefined || asked || shareSlug.value) {
        ready.value = true
        return
      }
      asked = true
      try {
        // Listed accounts all have data; the owner's own come first.
        const page = await call(
          client.collections.perspectives.$get(
            { query: {} },
            { init: { signal: controller.signal } },
          ),
        )
        fallback.value = page.items.find((item) => item.own)?.id ?? ''
      } catch {
        // No viewer, then.
      }
      ready.value = true
    },
    { immediate: true },
  )
  const viewer = computed(() =>
    shareSlug.value ? '' : (given.value ?? fallback.value),
  )
  function setViewer(key: string) {
    void router.replace({ query: { ...route.query, viewer: key } })
  }
  return { viewer, ready, setViewer }
}
