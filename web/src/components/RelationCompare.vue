<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { errorText, type RelationCompare } from '../api'
import {
  accountViews,
  compareModel,
  followMatrix,
  itemViews,
  parseSubset,
  SIDES,
  subsetKey,
  type CompareSide,
} from '../compare'
import { useGraphCanvas } from '../composables/useGraphCanvas'
import { useViewer } from '../composables/useViewer'
import { GRAPH_PAGE } from '../graph'
import { readCompare } from '../reads'
import {
  briefFetchNote,
  defaultRelMin,
  perspectiveName,
  relationQuery,
  relMinOf,
} from '../relation-filter'
import { formatCount } from '../trends'
import CompareCombos from './CompareCombos.vue'
import GraphNodeCard from './GraphNodeCard.vue'
import MiniAvatar from './MiniAvatar.vue'
import PerspectivePicker from './PerspectivePicker.vue'
import AppLink from './ui/AppLink.vue'
import Spinner from './ui/Spinner.vue'
import ViewerBar from './ViewerBar.vue'
import ViewerMark from './ViewerMark.vue'
// 关系对比: several accounts side by side. Who follows whom among them, then
// for one side (whom they follow, or who follows them) the accounts at least
// k of them share, by exact subset, as a grid or a graph. Everything is in
// the address: the accounts (`rel_of`, in order), `rel`, `rel_min`, the
// subset shown alone (`only`), the view and the viewer.
const props = defineProps<{ showSensitive?: boolean }>()
const route = useRoute()
const router = useRouter()
/** The address while this page is the one shown (it stays cached). */
let last = route.query
const query = computed(() =>
  route.name === 'compare' ? (last = route.query) : last,
)
const values = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string' && !!item,
  )
const keys = computed(() => [...new Set(values(query.value.rel_of))])
const side = computed<CompareSide>(() =>
  query.value.rel === 'followers' ? 'followers' : 'following',
)
const min = computed(() =>
  relMinOf(values(query.value.rel_min)[0] ?? null, keys.value.length),
)
const only = computed(() =>
  parseSubset(values(query.value.only)[0], keys.value.length),
)
/** The view asked for; without WebGL 2 it is the grid. */
const view = computed<'grid' | 'graph'>(() =>
  query.value.view === 'graph' ? 'graph' : 'grid',
)
const { viewer, ready, setViewer } = useViewer()
const dim = shallowRef(false)

function go(change: Record<string, string | string[] | undefined>) {
  const next: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries({ ...query.value, ...change }))
    if (value !== undefined && value !== null)
      next[key] = value as string | string[]
  void router.replace({ name: 'compare', query: next })
}
function setKeys(next: string[]) {
  const n = next.length
  // A subset or threshold of other accounts means nothing now.
  go({
    rel_of: next,
    only: undefined,
    rel_min:
      min.value > n || min.value === defaultRelMin(n)
        ? undefined
        : String(min.value),
  })
}
const adding = computed({
  get: () => [] as string[],
  set: (value: string[]) => setKeys([...keys.value, ...value]),
})
function remove(i: number) {
  setKeys(keys.value.filter((_key, j) => j !== i))
}
function step(by: number) {
  const n = keys.value.length
  const value = Math.min(n, Math.max(1, min.value + by))
  go({
    rel_min: value === defaultRelMin(n) ? undefined : String(value),
    only: undefined,
  })
}
function pick(of: number[] | undefined) {
  go({ only: of ? subsetKey(of) : undefined })
}

const data = shallowRef<RelationCompare>()
const error = shallowRef('')
const loading = shallowRef(false)
const limit = shallowRef(GRAPH_PAGE)
const selected = shallowRef<string>()
let controller = new AbortController()
async function load() {
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  if (!keys.value.length) {
    data.value = undefined
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await readCompare(
      {
        rel_of: keys.value,
        rel: side.value,
        rel_min: min.value,
        ...(only.value ? { only: only.value } : {}),
        limit: limit.value,
        ...(viewer.value ? { viewer: viewer.value } : {}),
      },
      signal,
    )
    if (signal.aborted) return
    data.value = result
    error.value = ''
  } catch (e) {
    if (!signal.aborted) error.value = errorText(e)
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(
  () =>
    ready.value
      ? [
          keys.value.join('\n'),
          side.value,
          min.value,
          only.value?.join(','),
          viewer.value,
        ].join('|')
      : '',
  (state, before) => {
    if (!state) return
    // A new question starts from the first accounts again.
    if (state !== before) limit.value = GRAPH_PAGE
    selected.value = undefined
    void load()
  },
  { immediate: true },
)
function more() {
  limit.value += GRAPH_PAGE
  void load()
}
onUnmounted(() => controller.abort())

const accounts = computed(() => accountViews(data.value, props.showSensitive))
const items = computed(() =>
  itemViews(data.value, side.value, props.showSensitive),
)
const model = computed(() =>
  compareModel(data.value, side.value, props.showSensitive),
)
const matrix = computed(() => (data.value ? followMatrix(data.value) : []))
const notes = computed(() =>
  (data.value?.accounts ?? []).map((account) =>
    briefFetchNote(
      perspectiveName(account.key, account),
      account.lists,
      side.value,
    ),
  ),
)
const marked = computed(
  () => model.value.nodes.filter((view) => view.viewer).length,
)
const viewerName = computed(() =>
  data.value?.viewer
    ? perspectiveName(data.value.viewer.key, data.value.viewer)
    : '',
)
const selectedView = computed(() =>
  model.value.nodes.find((view) => view.key === selected.value),
)
const selectedOf = computed(
  () => items.value.find((item) => item.key === selected.value)?.of,
)
const labels = (of: number[]) =>
  of.map((i) => accounts.value[i]?.label ?? '').join('、')
/** Why a tapped account is here, by the compared accounts' names. */
const why = computed(() => {
  const of = selectedOf.value
  if (!of) return ''
  return side.value === 'following'
    ? `${labels(of)} 关注了 TA`
    : `TA 关注了 ${labels(of)}`
})
const onlyText = computed(() => (only.value ? `仅 ${labels(only.value)}` : ''))
const BADGES = 4

const {
  height,
  error: canvasError,
  canvas,
  choose,
} = useGraphCanvas({
  stage: useTemplateRef<HTMLElement>('stage'),
  surface: useTemplateRef<HTMLElement>('surface'),
  controls: useTemplateRef<HTMLElement>('controls'),
  model,
  selected,
  mode: view,
  minHeight: () => window.innerHeight * 0.8,
  dim: computed(() => dim.value && marked.value > 0),
})
const mode = computed(() =>
  view.value === 'graph' && !canvasError.value ? 'graph' : 'grid',
)

/** 「在收藏库中查看」: the library under the same relation filter. */
const libraryRoute = computed(() => ({
  name: 'collections',
  query: relationQuery(keys.value, side.value, min.value),
}))
</script>

<template>
  <div class="compare-page">
    <section class="accounts" aria-label="对比的账号">
      <ul class="centers">
        <li v-for="(account, i) in accounts" :key="account.node.key">
          <button
            type="button"
            class="center"
            :class="{ on: account.key === selected }"
            @click="choose(account.key, $event)"
            @auxclick="choose(account.key, $event)"
          >
            <span class="avatar"
              ><MiniAvatar :view="account" :size="48" /><ViewerMark
                v-if="account.viewer"
                :relation="account.viewer"
            /></span>
            <span class="name">{{ account.label }}</span>
          </button>
          <button
            v-if="accounts.length > 1"
            type="button"
            class="remove"
            :aria-label="`移除 ${account.label}`"
            @click="remove(i)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </li>
      </ul>
      <div class="add">
        <PerspectivePicker
          v-model="adding"
          label="添加账号"
          empty=""
          :exclude="keys"
        />
      </div>
      <div v-if="accounts.length > 1" class="matrix-wrap">
        <table class="matrix">
          <caption>
            行关注列
          </caption>
          <thead>
            <tr>
              <td />
              <th v-for="account in accounts" :key="account.key" scope="col">
                <MiniAvatar :view="account" :size="22" />
                <span class="sr">{{ account.label }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, a) in matrix" :key="a">
              <th scope="row">
                <MiniAvatar :view="accounts[a]!" :size="22" />
                <span class="sr">{{ accounts[a]!.label }}</span>
              </th>
              <td
                v-for="(follows, b) in row"
                :key="b"
                :class="{ self: a === b, yes: follows }"
              >
                {{ a === b ? '' : follows ? '✓' : '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul v-if="notes.length" class="notes">
        <li v-for="note in notes" :key="note">{{ note }}</li>
      </ul>
    </section>

    <div ref="controls" class="controls">
      <div class="row">
        <div class="segments" role="group" aria-label="对比方向">
          <button
            v-for="option in SIDES"
            :key="option.value"
            type="button"
            :class="{ on: side === option.value }"
            :aria-pressed="side === option.value"
            @click="go({ rel: option.value, only: undefined })"
          >
            {{ option.label }}
          </button>
        </div>
        <div
          v-if="keys.length > 1"
          class="min"
          role="group"
          aria-label="至少几人"
        >
          <span class="min-label">至少</span>
          <button
            type="button"
            class="step"
            aria-label="减少"
            :disabled="min <= 1"
            @click="step(-1)"
          >
            −
          </button>
          <output class="min-value" aria-live="polite">{{ min }}</output>
          <button
            type="button"
            class="step"
            aria-label="增加"
            :disabled="min >= keys.length"
            @click="step(1)"
          >
            +
          </button>
          <span class="min-label">人</span>
        </div>
      </div>
      <CompareCombos
        v-if="data && data.combos.length"
        :data="data"
        :accounts="accounts"
        :selected="only ? subsetKey(only) : undefined"
        @pick="pick"
      />
      <ViewerBar
        v-model:dim="dim"
        :viewer="viewer"
        :info="data?.viewer"
        :marked="marked"
        @change="setViewer"
      />
      <div class="row result">
        <p class="total">
          <template v-if="data"
            >{{ formatCount(data.total) }} 个账号<button
              v-if="onlyText"
              type="button"
              class="only"
              :aria-label="`${onlyText}，显示全部组合`"
              @click="pick(undefined)"
            >
              {{ onlyText }} ×
            </button></template
          >
          <Spinner v-if="loading" label="正在加载" class="busy" />
        </p>
        <AppLink v-if="keys.length" class="link" :to="libraryRoute">
          在收藏库中查看
        </AppLink>
        <div class="modes" role="group" aria-label="显示方式">
          <button
            type="button"
            :class="{ on: mode === 'grid' }"
            :aria-pressed="mode === 'grid'"
            @click="go({ view: undefined })"
          >
            列表
          </button>
          <button
            type="button"
            :class="{ on: mode === 'graph' }"
            :aria-pressed="mode === 'graph'"
            :disabled="!!canvasError"
            @click="go({ view: 'graph' })"
          >
            图谱
          </button>
        </div>
      </div>
      <p v-if="error" class="banner" role="alert">{{ error }}</p>
      <p v-if="canvasError" class="banner" role="alert">{{ canvasError }}</p>
    </div>

    <div ref="stage" class="stage" :style="{ height: `${height}px` }">
      <div v-show="mode === 'graph'" ref="surface" class="surface" />
      <div v-if="mode === 'grid'" class="grid">
        <p v-if="data && !data.total && !loading" class="empty">
          没有符合条件的账号
        </p>
        <ul>
          <li v-for="item in items" :key="item.key">
            <button
              type="button"
              class="person"
              :class="{ on: item.key === selected }"
              @click="choose(item.key, $event)"
              @auxclick="choose(item.key, $event)"
            >
              <span
                class="avatar"
                :class="{ faded: dim && marked && !item.viewer }"
                ><MiniAvatar :view="item" :size="52" /><ViewerMark
                  v-if="item.viewer"
                  :relation="item.viewer"
              /></span>
              <span class="name">{{ item.label }}</span>
              <span class="badges" :aria-label="labels(item.of)">
                <MiniAvatar
                  v-for="i in item.of.slice(0, BADGES)"
                  :key="i"
                  :view="accounts[i]!"
                  :size="16"
                />
                <span v-if="item.of.length > BADGES" class="extra"
                  >+{{ item.of.length - BADGES }}</span
                >
              </span>
            </button>
          </li>
        </ul>
      </div>
      <p v-if="!data && loading" class="loading">
        <Spinner label="正在加载" />
      </p>
      <div
        v-if="mode === 'graph' && data && !canvasError"
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
          v-if="data && items.length < data.total"
          type="button"
          class="more"
          :disabled="loading"
          @click="more"
        >
          显示更多<span class="count"
            >{{ formatCount(items.length) }} /
            {{ formatCount(data.total) }}</span
          >
        </button>
        <GraphNodeCard
          v-if="selectedView"
          :view="selectedView"
          :show-sensitive="showSensitive"
          :viewer-name="viewerName"
          @close="selected = undefined"
        >
          <span v-if="why" class="why">{{ why }}</span>
        </GraphNodeCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compare-page {
  padding: 0 var(--gutter);
}
.accounts {
  margin-bottom: 12px;
}
.centers {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 4px 0;
  overflow-x: auto;
  list-style: none;
}
.centers li {
  position: relative;
  flex: none;
}
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 76px;
  padding: 6px 2px;
  border-radius: 12px;
}
.center.on,
.center:active {
  background: var(--fill);
}
.center .name {
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remove {
  position: absolute;
  top: 0;
  right: 4px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--card);
  color: var(--subtle);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.remove svg,
.zoom svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.add {
  margin-top: 8px;
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
}
.matrix-wrap {
  margin-top: 8px;
  padding: 8px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  overflow-x: auto;
}
.matrix {
  border-collapse: collapse;
  font-size: 13px;
}
.matrix caption {
  padding-bottom: 6px;
  color: var(--subtle);
  font-size: 12px;
  text-align: left;
}
.matrix th,
.matrix td {
  width: 30px;
  height: 30px;
  padding: 0;
  text-align: center;
}
.matrix td {
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
.matrix td.self {
  background: var(--fill);
}
.matrix td.yes {
  color: var(--link);
  font-weight: 700;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.notes {
  margin: 8px 4px 0;
  padding: 0;
  list-style: none;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.6;
}
.controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 8px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.segments,
.modes {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 17px;
  background: var(--fill);
}
.segments button,
.modes button {
  min-height: 30px;
  padding: 0 14px;
  border-radius: 15px;
  color: var(--subtle);
  font-size: 14px;
}
.segments button.on,
.modes button.on {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.modes button:disabled {
  opacity: 0.4;
}
.min {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.min-label {
  color: var(--subtle);
}
.step {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--card);
  color: var(--text);
  font-size: 18px;
  line-height: 1;
  box-shadow: inset 0 0 0 1px var(--separator);
}
.step:disabled {
  opacity: 0.35;
}
.min-value {
  min-width: 1.5em;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.result .total {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 4px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.only {
  min-height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  background: var(--card);
  color: var(--link);
  font-size: 13px;
  box-shadow: inset 0 0 0 1px var(--separator);
}
.link {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  color: var(--link);
  font-size: 14px;
}
button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.busy {
  color: var(--subtle);
}
.banner {
  margin: 0;
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
  touch-action: none;
}
.grid {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 8px 96px;
}
.grid ul {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.empty {
  margin: 24px 0;
  color: var(--subtle);
  text-align: center;
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
  position: relative;
  display: inline-grid;
}
.avatar.faded {
  opacity: 0.25;
}
.avatar :deep(.viewer-mark) {
  position: absolute;
  top: -3px;
  right: -3px;
}
.person .name {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.3;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.badges {
  display: flex;
  align-items: center;
  gap: 2px;
}
.extra {
  color: var(--subtle);
  font-size: 11px;
}
.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--subtle);
}
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
.zoom svg {
  width: 18px;
  height: 18px;
}
.zoom button + button {
  box-shadow: inset 0 1px 0 var(--separator);
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
.why {
  margin-top: 4px;
  font-size: 13px;
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
.more .count {
  margin-left: 4px;
  color: var(--subtle);
}
.more:disabled {
  opacity: 0.6;
}
</style>
