<script setup vapor lang="ts">
import {
  computed,
  onActivated,
  onMounted,
  onUnmounted,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import { errorText, type FollowGraph } from '../api'
import {
  GRAPH_PAGE,
  graphKinds,
  graphModel,
  kindLabels,
  listsText,
  type GraphKind,
} from '../graph'
import { readGraph } from '../reads'
import { collectionRoute } from '../share'
import { formatCount } from '../trends'
import GraphNodeCard from './GraphNodeCard.vue'
import Spinner from './ui/Spinner.vue'
import type { GraphCanvas } from '../graph-canvas'
// 关系图谱: a profile, the accounts it follows and that follow it, and the
// follows among them, drawn with sigma. The renderer loads with this page.
const props = defineProps<{ id: string; showSensitive?: boolean }>()
const graph = shallowRef<FollowGraph>()
const error = shallowRef('')
const loading = shallowRef(false)
const kinds = shallowRef<GraphKind[]>([...graphKinds])
const limit = shallowRef(GRAPH_PAGE)
/** The node tapped, by its entity id. */
const selected = shallowRef<string>()
let controller = new AbortController()
async function load() {
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  try {
    const all = kinds.value.length === graphKinds.length
    const result = await readGraph(
      props.id,
      { ...(all ? {} : { kinds: kinds.value }), limit: limit.value },
      signal,
    )
    if (signal.aborted) return
    graph.value = result
    error.value = ''
  } catch (e) {
    if (!signal.aborted) error.value = errorText(e)
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(
  () => props.id,
  () => {
    graph.value = undefined
    selected.value = undefined
    kinds.value = [...graphKinds]
    limit.value = GRAPH_PAGE
    void load()
  },
  { immediate: true },
)
function toggle(kind: GraphKind) {
  kinds.value = kinds.value.includes(kind)
    ? kinds.value.filter((k) => k !== kind)
    : graphKinds.filter((k) => k === kind || kinds.value.includes(k))
  limit.value = GRAPH_PAGE
  void load()
}
function more() {
  limit.value += GRAPH_PAGE
  void load()
}
onUnmounted(() => controller.abort())

const model = computed(() =>
  graphModel(graph.value, { showSensitive: props.showSensitive }),
)
/** Accounts shown besides the center. */
const shown = computed(() => Math.max(0, model.value.nodes.length - 1))
const lists = computed(() => listsText(graph.value?.lists))
const selectedView = computed(() =>
  model.value.nodes.find((node) => node.key === selected.value),
)

const stage = useTemplateRef<HTMLElement>('stage')
const height = shallowRef(0)
/** The canvas takes the rest of the viewport below the controls. */
function fit() {
  const element = stage.value
  if (!element) return
  const top = element.getBoundingClientRect().top + window.scrollY
  height.value = Math.max(320, window.innerHeight - top - 12)
}
let canvas: GraphCanvas | undefined
const canvasError = shallowRef('')
let disposed = false
let observer: MutationObserver | undefined
const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
onMounted(async () => {
  fit()
  window.addEventListener('resize', fit)
  try {
    const { createGraphCanvas, readTheme } = await import('../graph-canvas')
    if (disposed || !stage.value) return
    canvas = createGraphCanvas(stage.value, {
      theme: readTheme(),
      onSelect: (key) => (selected.value = key),
    })
    const retheme = () => canvas?.setTheme(readTheme())
    // Telegram sets its colours on the root's style; the app its data-theme.
    observer = new MutationObserver(retheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    })
    scheme?.addEventListener('change', retheme)
    canvas.show(model.value)
  } catch {
    // Sigma needs WebGL 2.
    canvasError.value = '此设备无法显示关系图谱。'
  }
})
watch(model, (value) => {
  canvas?.show(value)
  canvas?.select(selected.value)
})
watch(selected, (key) => canvas?.select(key))
// After the new height is laid out.
watch(height, () => requestAnimationFrame(() => canvas?.resize()))
onUnmounted(() => {
  disposed = true
  window.removeEventListener('resize', fit)
  observer?.disconnect()
  canvas?.kill()
})

// Back from the cache: the viewport may have changed meanwhile.
onActivated(() => {
  fit()
  requestAnimationFrame(() => canvas?.resize())
})

const router = useRouter()
function center(id: string) {
  void router.push(collectionRoute(id, 'graph'))
}
function open(id: string) {
  void router.push(collectionRoute(id))
}
</script>

<template>
  <div class="graph-page">
    <div class="controls">
      <div class="chips" role="group" aria-label="显示的账号">
        <button
          v-for="kind in graphKinds"
          :key="kind"
          type="button"
          class="chip"
          :class="[kind, { on: kinds.includes(kind) }]"
          :aria-pressed="kinds.includes(kind)"
          @click="toggle(kind)"
        >
          <span class="dot" aria-hidden="true" />{{ kindLabels[kind]
          }}<span v-if="graph" class="count">{{
            formatCount(graph.kinds[kind])
          }}</span>
        </button>
        <Spinner v-if="loading && graph" label="正在加载" class="busy" />
      </div>
      <p v-if="lists" class="lists">{{ lists }}</p>
      <p v-if="error" class="banner" role="alert">{{ error }}</p>
      <p v-if="canvasError" class="banner" role="alert">{{ canvasError }}</p>
    </div>
    <div ref="stage" class="stage" :style="{ height: `${height}px` }">
      <p v-if="!graph && loading" class="loading">
        <Spinner label="正在加载" />
      </p>
      <div class="overlay">
        <button
          v-if="graph && shown < graph.total"
          type="button"
          class="more"
          :disabled="loading"
          @click="more"
        >
          显示更多<span class="count"
            >{{ formatCount(shown) }} / {{ formatCount(graph.total) }}</span
          >
        </button>
        <GraphNodeCard
          v-if="selectedView"
          :view="selectedView"
          :show-sensitive="showSensitive"
          @center="center"
          @open="open"
          @close="selected = undefined"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-page {
  padding: 0 var(--gutter);
}
.controls {
  padding: 0 0 8px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  background: var(--card);
  color: var(--subtle);
  font-size: 14px;
  box-shadow: inset 0 0 0 1px var(--separator);
}
.chip.on {
  color: var(--text);
  box-shadow: inset 0 0 0 1.5px currentColor;
}
.chip:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fill);
}
.chip.following.on .dot {
  background: #2f7fd8;
}
.chip.followers.on .dot {
  background: #d9822b;
}
.chip.mutual.on .dot {
  background: #2e9e5b;
}
.count {
  margin-left: 4px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.busy {
  color: var(--subtle);
}
.lists {
  margin: 8px 4px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.banner {
  margin: 8px 0 0;
  padding: 12px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
}
.stage {
  position: relative;
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
  /* The canvas takes every gesture: pinch zooms it, not the page. */
  touch-action: none;
}
.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--subtle);
}
.overlay {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.overlay > * {
  pointer-events: auto;
}
.overlay > :deep(.card) {
  align-self: stretch;
  max-width: 480px;
  margin: 0 auto;
  width: 100%;
}
.more {
  min-height: 36px;
  padding: 0 16px;
  border-radius: 18px;
  background: var(--card);
  color: var(--link);
  font-size: 14px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.16);
}
.more:disabled {
  opacity: 0.6;
}
</style>
