<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
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
import { defaultOptions, type Options } from '../capture-options'
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
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const current = shallowRef<Watch>()
const preview = shallowRef<UpdatePreview>()
const loaded = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const every = shallowRef<WatchEvery>(DEFAULT_EVERY)
const options = shallowRef<Options>(defaultOptions())
let request = 0

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
      const restored: Options = { ...defaultOptions(), ...w.options }
      options.value = restored
    }
  }
  if (covers.status === 'fulfilled') preview.value = covers.value
  loaded.value = found.status === 'fulfilled'
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      void load()
      dialog.value?.showModal()
    } else {
      ++request
      dialog.value?.close()
    }
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
    const saved = await call(
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
            ...options.value,
            relations: listable.value && options.value.relations,
          },
        },
      }),
    )
    toast(current.value ? '已保存' : '已开启定期更新')
    current.value = saved
    emit('changed', saved)
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
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('cancel')
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
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="emit('cancel')"
  >
    <div class="group">
      <p :id="titleId" class="head">{{ title }}</p>
      <p v-if="!loaded && !error" class="note" role="status">加载中…</p>
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
              >最短 5 分钟；上一次还没结束时跳过这一次</small
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
      <button
        type="button"
        class="action strong"
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
    </div>
    <button type="button" class="group action cancel" @click="emit('cancel')">
      取消
    </button>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 480px;
  max-height: calc(100dvh - 16px);
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
  overflow-y: auto;
}
.sheet:not([open]) {
  display: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.group {
  width: 100%;
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.head {
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
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
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.action:disabled {
  color: var(--subtle);
}
.strong {
  font-weight: 600;
}
.destructive {
  color: var(--destructive);
}
.cancel {
  color: var(--link);
  box-shadow: none;
}
</style>
