import {
  onActivated,
  onMounted,
  onUnmounted,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import { useRouter } from 'vue-router'
import { navigatesHere, openInNewTab } from '../navigation'
import { collectionRoute } from '../share'
import type { GraphModel } from '../graph'
import type { GraphCanvas } from '../graph-canvas'

/**
 * The graph canvas of a page: sigma and the label layer, loaded on demand
 * into `surface`, shown at the height left below the controls, following
 * the theme, the model, the node chosen and whether unmarked nodes fade.
 * Without WebGL 2 it says so in `error`, and the page lists instead.
 */
export function useGraphCanvas(options: {
  stage: Readonly<Ref<HTMLElement | null>>
  surface: Readonly<Ref<HTMLElement | null>>
  controls: Readonly<Ref<HTMLElement | null>>
  model: Readonly<Ref<GraphModel>>
  selected: Ref<string | undefined>
  /** Changes when the canvas is shown again after the list. */
  mode: Readonly<Ref<string>>
  dim?: Readonly<Ref<boolean>>
  /**
   * The least height, for a stage that starts far down a long page: the
   * page scrolls to it then.
   */
  minHeight?: () => number
}) {
  const router = useRouter()
  /**
   * An account clicked, on the canvas or in the list: its card, or its page
   * in a new tab when clicked as a link would be to open one there (Cmd,
   * Ctrl, Shift or the middle button). Only a saved profile has a page.
   */
  function choose(key: string, event?: MouseEvent) {
    const id = options.model.value.nodes.find((view) => view.key === key)?.node
      .collection_id
    if (id && event && !navigatesHere(event))
      openInNewTab(router, collectionRoute(id))
    else options.selected.value = key
  }
  const height = shallowRef(0)
  const error = shallowRef('')
  const canvas = shallowRef<GraphCanvas>()
  /** The stage takes the rest of the viewport below the controls. */
  function fitHeight() {
    const element = options.stage.value
    if (!element) return
    const top = element.getBoundingClientRect().top + window.scrollY
    height.value = Math.max(
      320,
      options.minHeight?.() ?? 0,
      window.innerHeight - top - 12,
    )
  }
  let disposed = false
  let observer: MutationObserver | undefined
  // The controls grow when the counts arrive and the chips wrap, or a
  // banner shows: the stage below moves down and must end at the viewport.
  const growth =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => fitHeight())
  const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  onMounted(async () => {
    fitHeight()
    window.addEventListener('resize', fitHeight)
    if (options.controls.value) growth?.observe(options.controls.value)
    try {
      const { createGraphCanvas, readTheme } = await import('../graph-canvas')
      if (disposed || !options.surface.value) return
      const created = createGraphCanvas(options.surface.value, {
        theme: readTheme(),
        onSelect: (key) => (options.selected.value = key),
        onOpen: choose,
      })
      canvas.value = created
      const retheme = () => created.setTheme(readTheme())
      // Telegram sets its colours on the root's style; the app its data-theme.
      observer = new MutationObserver(retheme)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-theme'],
      })
      scheme?.addEventListener('change', retheme)
      created.setDim(!!options.dim?.value)
      created.show(options.model.value)
      created.select(options.selected.value)
    } catch {
      // Sigma needs WebGL 2.
      error.value = '此设备无法显示关系图谱。'
    }
  })
  watch(options.model, (value) => {
    canvas.value?.show(value)
    canvas.value?.select(options.selected.value)
  })
  watch(options.selected, (key) => canvas.value?.select(key))
  if (options.dim) watch(options.dim, (dim) => canvas.value?.setDim(dim))
  // After the new height is laid out, or the canvas is shown again.
  watch([height, options.mode], () =>
    requestAnimationFrame(() => canvas.value?.resize()),
  )
  onUnmounted(() => {
    disposed = true
    window.removeEventListener('resize', fitHeight)
    observer?.disconnect()
    growth?.disconnect()
    canvas.value?.kill()
  })
  // Back from the cache: the viewport may have changed meanwhile.
  onActivated(() => {
    fitHeight()
    requestAnimationFrame(() => canvas.value?.resize())
  })
  return { height, error, canvas, choose }
}
