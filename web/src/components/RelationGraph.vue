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
  graphGroups,
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
// follows among them, drawn with sigma (the renderer loads with this page),
// or listed by kind.
const props = defineProps<{ id: string; showSensitive?: boolean }>()
const graph = shallowRef<FollowGraph>()
const error = shallowRef('')
const loading = shallowRef(false)
const kinds = shallowRef<GraphKind[]>([...graphKinds])
const limit = shallowRef(GRAPH_PAGE)
/** The node tapped, by its entity id. */
const selected = shallowRef<string>()
const mode = shallowRef<'graph' | 'list'>('graph')
const modes = [
  { value: 'graph', label: '图谱' },
  { value: 'list', label: '列表' },
] as const
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
const groups = computed(() => graphGroups(model.value))
const lists = computed(() => listsText(graph.value?.lists))
const selectedView = computed(() =>
  model.value.nodes.find((node) => node.key === selected.value),
)
/** Avatars in the list that failed to load, shown by their initial instead. */
const broken = shallowRef(new Set<string>())
function brokenImage(key: string) {
  broken.value = new Set(broken.value).add(key)
}

const stage = useTemplateRef<HTMLElement>('stage')
const surface = useTemplateRef<HTMLElement>('surface')
const height = shallowRef(0)
/** The stage takes the rest of the viewport below the controls. */
function fitHeight() {
  const element = stage.value
  if (!element) return
  const top = element.getBoundingClientRect().top + window.scrollY
  height.value = Math.max(320, window.innerHeight - top - 12)
}
let canvas: GraphCanvas | undefined
const canvasError = shallowRef('')
let disposed = false
let observer: MutationObserver | undefined
const controls = useTemplateRef<HTMLElement>('controls')
// The controls grow when the counts arrive and the chips wrap, or a
// banner shows: the stage below moves down and must end at the viewport.
const growth =
  typeof ResizeObserver === 'undefined'
    ? undefined
    : new ResizeObserver(() => fitHeight())
const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
onMounted(async () => {
  fitHeight()
  window.addEventListener('resize', fitHeight)
  if (controls.value) growth?.observe(controls.value)
  try {
    const { createGraphCanvas, readTheme } = await import('../graph-canvas')
    if (disposed || !surface.value) return
    canvas = createGraphCanvas(surface.value, {
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
    mode.value = 'list'
  }
})
watch(model, (value) => {
  canvas?.show(value)
  canvas?.select(selected.value)
})
watch(selected, (key) => canvas?.select(key))
// After the new height is laid out, or the canvas is shown again.
watch([height, mode], () => requestAnimationFrame(() => canvas?.resize()))
onUnmounted(() => {
  disposed = true
  window.removeEventListener('resize', fitHeight)
  observer?.disconnect()
  growth?.disconnect()
  canvas?.kill()
})

// Back from the cache: the viewport may have changed meanwhile.
onActivated(() => {
  fitHeight()
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
    <div ref="controls" class="controls">
      <div class="row">
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
        <div class="modes" role="group" aria-label="显示方式">
          <button
            v-for="option in modes"
            :key="option.value"
            type="button"
            :class="{ on: mode === option.value }"
            :aria-pressed="mode === option.value"
            :disabled="option.value === 'graph' && !!canvasError"
            @click="mode = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <p v-if="lists" class="lists">{{ lists }}</p>
      <p v-if="error" class="banner" role="alert">{{ error }}</p>
      <p v-if="canvasError" class="banner" role="alert">{{ canvasError }}</p>
    </div>
    <div ref="stage" class="stage" :style="{ height: `${height}px` }">
      <div v-show="mode === 'graph'" ref="surface" class="surface" />
      <div v-if="mode === 'list'" class="list">
        <section v-for="group in groups" :key="group.kind" class="group">
          <h2 :class="group.kind">
            <span class="dot" aria-hidden="true" />{{ kindLabels[group.kind]
            }}<span class="count">{{ formatCount(group.nodes.length) }}</span>
          </h2>
          <ul>
            <li v-for="view in group.nodes" :key="view.key">
              <button
                type="button"
                class="person"
                :class="{ on: view.key === selected }"
                @click="selected = view.key"
              >
                <span class="avatar" :class="group.kind">
                  <img
                    v-if="view.image && !broken.has(view.key)"
                    :src="view.image"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    @error="brokenImage(view.key)"
                  />
                  <span v-else class="initial" aria-hidden="true">{{
                    view.initial
                  }}</span>
                </span>
                <span class="name">{{ view.label }}</span>
                <span v-if="view.node.followers !== undefined" class="followers"
                  >粉丝 {{ formatCount(view.node.followers) }}</span
                >
              </button>
            </li>
          </ul>
        </section>
      </div>
      <p v-if="!graph && loading" class="loading">
        <Spinner label="正在加载" />
      </p>
      <div
        v-if="mode === 'graph' && graph && !canvasError"
        class="zoom"
        role="group"
        aria-label="缩放"
      >
        <button
          type="button"
          aria-label="放大"
          title="放大"
          @click="canvas?.zoomIn()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6v12M6 12h12" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="缩小"
          title="缩小"
          @click="canvas?.zoomOut()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 12h12" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="显示全部"
          title="显示全部"
          @click="canvas?.fit()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4" />
          </svg>
        </button>
      </div>
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
.row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.chips {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
.chip:focus-visible,
.modes button:focus-visible,
.zoom button:focus-visible,
.person:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fill);
}
.chip.following.on .dot,
h2.following .dot {
  background: #2f7fd8;
}
.chip.followers.on .dot,
h2.followers .dot {
  background: #d9822b;
}
.chip.mutual.on .dot,
h2.mutual .dot {
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
.modes {
  flex: none;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 17px;
  background: var(--fill);
}
.modes button {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  color: var(--subtle);
  font-size: 14px;
}
.modes button.on {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.modes button:disabled {
  opacity: 0.4;
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
}
.surface {
  position: absolute;
  inset: 0;
  /* The canvas takes every gesture: pinch zooms it, not the page. */
  touch-action: none;
}
.list {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* Room for the card and 「显示更多」 over the last row. */
  padding: 4px 8px 96px;
}
.group h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 8px 6px;
  font-size: 15px;
  font-weight: 600;
}
.group ul {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.person {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 8px 4px;
  border-radius: 12px;
  text-align: center;
}
.person:active,
.person.on {
  background: var(--fill);
}
.avatar {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--fill);
  box-shadow:
    0 0 0 2px var(--card),
    0 0 0 4px var(--ring);
}
.avatar.following {
  --ring: #2f7fd8;
}
.avatar.followers {
  --ring: #d9822b;
}
.avatar.mutual {
  --ring: #2e9e5b;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.initial {
  font-size: 20px;
  font-weight: 600;
}
.name {
  display: -webkit-box;
  max-width: 100%;
  margin-top: 4px;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.3;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.followers {
  color: var(--subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--subtle);
}
/* Pinch zooms on a touch screen; buttons where there is a mouse. */
.zoom {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: none;
  flex-direction: column;
  border-radius: 10px;
  background: var(--card);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}
@media (hover: hover) and (pointer: fine) {
  .zoom {
    display: flex;
  }
}
.zoom button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  color: var(--text);
}
.zoom button + button {
  box-shadow: inset 0 1px 0 var(--separator);
}
.zoom button:hover {
  background: var(--fill);
}
.zoom svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
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
