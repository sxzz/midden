<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type IntervalUnit,
  type UpdatePreview,
  type Watch,
  type WatchEvery,
  type WatchTarget,
} from '../api'
import {
  defaultOptions,
  optionsBody,
  restoreOptions,
  type Options,
} from '../capture-options'
import { toast } from '../composables/useToast'
import {
  DEFAULT_EVERY,
  fitCount,
  lastRunText,
  MAX_COUNT,
  nextRunText,
  units,
} from '../watches'
import CaptureOptions from './CaptureOptions.vue'
import AppLink from './ui/AppLink.vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import SheetDialog from './ui/SheetDialog.vue'
import SkeletonBox from './ui/SkeletonBox.vue'
/**
 * 定期更新 of a profile or a folder: how often, and the options each run
 * uses, as the 更新 sheet has them. Also where its watch is removed.
 */
const props = defineProps<{
  open: boolean
  target: WatchTarget
  /** What it updates, for the title: @foo, 收藏夹「猫」. */
  label?: string
}>()
const emit = defineEmits<{
  /** Saved or removed (undefined). */
  changed: [watch: Watch | undefined]
  /** A link here navigates: the sheet should close. */
  navigate: []
  cancel: []
}>()
const current = shallowRef<Watch>()
const preview = shallowRef<UpdatePreview>()
const loaded = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const every = shallowRef<WatchEvery>(DEFAULT_EVERY)
const options = shallowRef<Options>(defaultOptions())
let request = 0
/** The form as loaded or last saved, to tell unsaved edits. */
const saved = shallowRef('')
const snapshot = () =>
  JSON.stringify({ every: every.value, options: options.value })
const dirty = computed(() => loaded.value && snapshot() !== saved.value)

async function load() {
  const n = ++request
  loaded.value = false
  error.value = ''
  current.value = undefined
  preview.value = undefined
  every.value = DEFAULT_EVERY
  options.value = defaultOptions()
  const target = props.target
  const [found, covers] = await Promise.allSettled([
    call(
      client.watches.$get({ query: { target: target.target, id: target.id } }),
    ),
    // Which options apply; an empty folder has none to say, and shows all.
    call(client.updates.preview.$post({ json: { target } })),
  ])
  if (n !== request) return
  if (found.status === 'rejected') error.value = errorText(found.reason)
  else {
    const w = found.value.items[0]
    current.value = w
    if (w) {
      every.value = w.every
      options.value = restoreOptions(w.options)
    }
  }
  if (covers.status === 'fulfilled') preview.value = covers.value
  loaded.value = found.status === 'fulfilled'
  saved.value = snapshot()
}
watch(
  () => props.open,
  (open) => {
    if (open) void load()
    else ++request
  },
)
const title = computed(() =>
  props.label ? `定期更新 ${props.label}` : '定期更新',
)
const profiles = computed(() =>
  preview.value ? preview.value.profiles > 0 : true,
)
const posts = computed(() => (preview.value ? preview.value.posts > 0 : true))
const listable = computed(() =>
  preview.value ? preview.value.listable > 0 : true,
)
const status = computed(() => {
  const w = current.value
  return w ? nextRunText(w) : ''
})
const last = computed(() => (current.value ? lastRunText(current.value) : ''))

async function save() {
  if (busy.value || !loaded.value) return
  busy.value = true
  error.value = ''
  try {
    const written = await call(
      client.watches.$put({
        json: {
          ...props.target,
          every: {
            unit: every.value.unit,
            count: fitCount(every.value.count, every.value.unit),
          },
          // Months and years count in the owner's zone: this browser's.
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          options: {
            ...optionsBody(options.value),
            relations: listable.value && options.value.relations,
          },
        },
      }),
    )
    toast(current.value ? '已保存' : '已开启定期更新')
    current.value = written
    saved.value = snapshot()
    emit('changed', written)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function remove() {
  const w = current.value
  if (busy.value || !w) return
  busy.value = true
  error.value = ''
  try {
    await call(client.watches[':id'].$delete({ param: { id: w.id } }))
    toast('已取消定期更新')
    current.value = undefined
    emit('changed', undefined)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
/** The number typed, made one the server takes for the unit. */
function setCount(event: Event) {
  const input = event.target as HTMLInputElement
  const count = fitCount(Number(input.value), every.value.unit)
  input.value = String(count)
  every.value = { ...every.value, count }
}
/**
 * What is typed counts at once, so choosing a unit right after typing
 * keeps the number; it is made one the server takes on leaving the field.
 */
function typeCount(event: Event) {
  const input = event.target as HTMLInputElement
  const count = Number(input.value)
  if (input.value && Number.isFinite(count))
    every.value = { ...every.value, count }
}
function setUnit(event: Event) {
  const unit = (event.target as HTMLSelectElement).value as IntervalUnit
  every.value = { unit, count: fitCount(every.value.count, unit) }
}
</script>

<template>
  <SheetDialog
    :open="open"
    :title="title"
    :dirty="dirty"
    wide
    @cancel="emit('cancel')"
  >
    <div
      v-if="!loaded && !error"
      class="note note-skeleton"
      role="status"
      aria-busy="true"
      aria-label="正在读取定期更新"
    >
      <SkeletonBox height="13px" width="58%" />
      <SkeletonBox height="13px" width="40%" />
    </div>
    <template v-if="loaded">
      <div v-if="current" class="facts">
        <p class="fact">{{ status }}</p>
        <p v-if="current.last_run" class="fact">
          <AppLink
            class="link"
            :to="{ name: 'capture', params: { id: current.last_run.id } }"
            @navigate="emit('navigate')"
            >{{ last }}</AppLink
          >
        </p>
        <p v-if="current.error" class="fact failed">
          上次未开始：{{ current.error }}
        </p>
      </div>
      <div class="row every" role="group" aria-label="频率">
        <span
          >频率<small class="hint"
            >最短5分钟；上一次还没结束时跳过这一次</small
          ></span
        >
        <span class="interval"
          >每<input
            class="value count"
            type="number"
            inputmode="numeric"
            min="1"
            :max="MAX_COUNT"
            step="1"
            aria-label="间隔"
            :value="every.count"
            :disabled="busy"
            @input="typeCount"
            @change="setCount" /><span class="select"
            ><select
              class="value"
              aria-label="单位"
              :value="every.unit"
              :disabled="busy"
              @change="setUnit"
            >
              <option v-for="u in units" :key="u.value" :value="u.value">
                {{ u.label }}
              </option></select
            ><ChevronIcon class="select-chevron" /></span
        ></span>
      </div>
      <CaptureOptions
        v-model="options"
        :profiles="profiles"
        :posts="posts"
        :relations="listable"
        :disabled="busy"
      />
    </template>
    <p v-if="error" class="note failed" role="alert">{{ error }}</p>
    <template #actions>
      <button
        type="button"
        class="action primary"
        :disabled="busy || !loaded"
        @click="save"
      >
        {{ current ? '保存' : '开启定期更新' }}
      </button>
      <button
        v-if="current"
        type="button"
        class="action destructive"
        :disabled="busy"
        @click="remove"
      >
        取消定期更新
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
/* While the facts load, bars where their lines will be. */
.note-skeleton {
  display: grid;
  gap: 10px;
  padding-top: 12px;
  padding-bottom: 12px;
}
/* Rows start a little under the title, behind their own hairline. */
.note-skeleton,
.facts,
.every:first-child {
  margin-top: 12px;
}
.facts {
  padding: 10px var(--inset);
  box-shadow: inset 0 1px 0 var(--separator);
}
.fact {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--subtle);
}
.link {
  color: var(--link);
}
.note {
  margin: 0;
  padding: 10px 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
  box-shadow: inset 0 1px 0 var(--separator);
}
.failed {
  color: var(--destructive);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  margin-left: var(--inset);
  padding: 6px var(--inset) 6px 0;
  font-size: 15px;
  box-shadow: inset 0 1px 0 var(--separator);
}
.value {
  min-height: 32px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  font-size: 15px;
  color: inherit;
}
.value:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.interval {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
input.count {
  width: 72px;
  padding: 4px 10px;
  text-align: right;
}
.select {
  position: relative;
  flex: none;
}
select.value {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 30px 4px 10px;
}
.select-chevron {
  position: absolute;
  right: 4px;
  top: calc(50% - 12px);
  pointer-events: none;
}
</style>
