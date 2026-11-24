<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { call, client, errorText, type Perspective } from '../api'
import { perspectiveName } from '../relation-filter'
import MultiSelect from './ui/MultiSelect.vue'
// Accounts with relation data, searched and paged on the server: the
// 「关系」 filter's perspectives, the accounts a comparison adds and the
// account a graph is marked from. The owner's capture accounts come first.
const props = defineProps<{
  label: string
  /** One account at most. */
  single?: boolean
  /** Accounts not to offer, such as those already compared. */
  exclude?: string[]
  /** The summary with nothing picked, `全部` by default. */
  empty?: string
}>()
const selected = defineModel<string[]>({ required: true })
const emit = defineEmits<{
  /** Every account seen so far, by key: names and list completeness. */
  known: [accounts: Record<string, Perspective>]
  /** The first page, once read: the owner's own accounts lead it. */
  first: [accounts: Perspective[]]
}>()
const items = shallowRef<Perspective[]>([])
const query = shallowRef('')
const next = shallowRef('')
const error = shallowRef('')
const loading = shallowRef(false)
const loaded = shallowRef(false)
const known = shallowRef<Record<string, Perspective>>({})
const controller = new AbortController()
onUnmounted(() => controller.abort())
function remember(found: Perspective[]) {
  if (!found.length) return
  known.value = {
    ...known.value,
    ...Object.fromEntries(found.map((item) => [item.id, item])),
  }
  emit('known', known.value)
}
const read = (q: { q?: string; cursor?: string; rel_of?: string[] }) =>
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
    const q = query.value.trim()
    const data = await read({
      q: q || undefined,
      cursor: more ? next.value : undefined,
    })
    if (current !== request) return
    remember(data.items)
    items.value = more ? [...items.value, ...data.items] : data.items
    next.value = data.next_cursor ?? ''
    if (!more && !q && !loaded.value) emit('first', data.items)
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
// Choices from the address need their names before the list opens.
watch(
  // Joined, so learning other accounts does not ask again.
  () => selected.value.filter((key) => !(key in known.value)).join('\n'),
  async (joined) => {
    if (!joined) return
    const missing = joined.split('\n')
    try {
      remember((await read({ rel_of: missing })).items)
    } catch {
      // Each key's own id stands in for the name.
    }
  },
  { immediate: true },
)
const name = (item: Perspective) => item.name || perspectiveName(item.id, item)
const labelOf = (key: string) =>
  known.value[key] ? name(known.value[key]) : perspectiveName(key)
const options = computed(() => {
  const hidden = new Set(props.exclude ?? [])
  const list = items.value
    .filter((item) => !hidden.has(item.id))
    .map((item) => ({
      value: item.id,
      label: name(item),
      sub: item.name && item.username ? `@${item.username}` : undefined,
    }))
  if (!query.value.trim())
    for (const key of selected.value)
      if (!list.some((option) => option.value === key))
        list.push({ value: key, label: labelOf(key), sub: undefined })
  return list
})
const names = computed(() =>
  Object.fromEntries(selected.value.map((key) => [key, labelOf(key)])),
)
defineExpose({ load })
</script>

<template>
  <MultiSelect
    v-model="selected"
    :label="label"
    remote
    :single="single"
    :empty="empty"
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
</template>

<style scoped>
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
