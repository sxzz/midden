<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { call, client, errorText, type Perspective } from '../api'
import {
  fetchNote,
  perspectiveName,
  relationChip,
  RELS,
  type Rel,
} from '../relation-filter'
import MultiSelect from './ui/MultiSelect.vue'
// The 「关系」 section of the filters: whose follows, then which of them.
const relOf = defineModel<string>('relOf', { required: true })
const rel = defineModel<Rel | ''>('rel', { required: true })
const emit = defineEmits<{
  /** The filter in the summary's words, empty without one. */
  summary: [text: string]
}>()
// Accounts come a page at a time and the search runs on the server: every
// account in a fetched list has relation data.
const items = shallowRef<Perspective[]>([])
const query = shallowRef('')
const next = shallowRef('')
const error = shallowRef('')
const loading = shallowRef(false)
const loaded = shallowRef(false)
/** Every account seen, so the chosen one reads by name and has its note. */
const known = shallowRef<Record<string, Perspective>>({})
const controller = new AbortController()
onUnmounted(() => controller.abort())
function remember(found: Perspective[]) {
  if (found.length)
    known.value = {
      ...known.value,
      ...Object.fromEntries(found.map((item) => [item.id, item])),
    }
}
const read = (q: { q?: string; cursor?: string; rel_of?: string }) =>
  call(
    client.collections.perspectives.$get(
      { query: q },
      { init: { signal: controller.signal } },
    ),
  )
let request = 0
async function load(more = false) {
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const data = await read({
      q: query.value.trim() || undefined,
      cursor: more ? next.value : undefined,
    })
    if (current !== request) return
    remember(data.items)
    items.value = more ? [...items.value, ...data.items] : data.items
    next.value = data.next_cursor ?? ''
    loaded.value = true
  } catch (e) {
    if (current === request && !controller.signal.aborted)
      error.value = errorText(e)
  } finally {
    if (current === request) loading.value = false
  }
}
function opened() {
  if (!loaded.value && !loading.value) void load()
}
let timer: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(timer))
function search(value: string) {
  query.value = value
  clearTimeout(timer)
  timer = setTimeout(load, 250)
}
// A choice from the address needs its name and note before the list opens.
watch(
  relOf,
  async (key) => {
    if (!key || key in known.value) return
    try {
      remember((await read({ rel_of: key })).items)
    } catch {
      // The key's own id stands in for the name.
    }
  },
  { immediate: true },
)
const chosen = computed(() =>
  relOf.value ? known.value[relOf.value] : undefined,
)
const name = (item: Perspective) => item.name || perspectiveName(item.id, item)
const options = computed(() => {
  const list = items.value.map((item) => ({
    value: item.id,
    label: name(item),
    sub: item.name && item.username ? `@${item.username}` : undefined,
  }))
  if (
    relOf.value &&
    !query.value.trim() &&
    !list.some((option) => option.value === relOf.value)
  )
    list.push({
      value: relOf.value,
      label: chosen.value ? name(chosen.value) : perspectiveName(relOf.value),
      sub: undefined,
    })
  return list
})
const names = computed(() =>
  relOf.value
    ? {
        [relOf.value]: chosen.value
          ? name(chosen.value)
          : perspectiveName(relOf.value),
      }
    : {},
)
const selected = computed({
  get: () => (relOf.value ? [relOf.value] : []),
  set(value: string[]) {
    const key = value[0] ?? ''
    // Picking an account starts from whom it follows.
    rel.value = key ? rel.value || 'following' : ''
    relOf.value = key
  },
})
const note = computed(() =>
  chosen.value && rel.value ? fetchNote(chosen.value, rel.value) : '',
)
watch(
  () =>
    relOf.value && rel.value
      ? relationChip(rel.value, perspectiveName(relOf.value, chosen.value))
      : '',
  (text) => emit('summary', text),
  { immediate: true },
)
</script>

<template>
  <div class="relation">
    <MultiSelect
      v-model="selected"
      label="关系"
      remote
      single
      :options="options"
      :names="names"
      :loading="loading"
      :more="!!next"
      @open="opened"
      @search="search"
      @more="load(true)"
    />
    <p v-if="error" class="hint" role="alert">
      {{ error }}
      <button type="button" class="retry" @click="load()">重试</button>
    </p>
    <div v-if="relOf" class="mode">
      <div class="segments" role="radiogroup" aria-label="关系方向">
        <label v-for="option in RELS" :key="option.value"
          ><input v-model="rel" type="radio" :value="option.value" /><span>{{
            option.label
          }}</span></label
        >
      </div>
      <p v-if="note" class="note">{{ note }}</p>
    </div>
  </div>
</template>

<style scoped>
.mode {
  padding: 0 var(--inset) 12px;
}
.segments {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--fill);
}
.segments label {
  position: relative;
  flex: 1;
  cursor: pointer;
}
.segments input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
}
.segments span {
  display: block;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 13px;
  text-align: center;
  white-space: nowrap;
}
.segments input:checked + span {
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}
.segments input:focus-visible + span {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
.note {
  margin: 8px 0 0;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.5;
}
.hint {
  margin: 0;
  padding: 0 var(--inset) 10px;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.5;
}
.retry {
  min-height: 32px;
  color: var(--link);
}
</style>
