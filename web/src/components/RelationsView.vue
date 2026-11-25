<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client, errorText } from '../api'
import { defaultCenter, lastCenter } from '../graph-center'
import PerspectivePicker from './PerspectivePicker.vue'
import RelationGraph from './RelationGraph.vue'
// 关系: the graph of one account with relation data (`of` in the address),
// picked here. Without one, the owner's own account, else the one last
// opened; with no relation data at all, only the picker.
defineProps<{ showSensitive?: boolean }>()
const route = useRoute()
const router = useRouter()
const center = shallowRef('')
const error = shallowRef('')
const controller = new AbortController()
onUnmounted(() => controller.abort())
/** The address's account; undefined while another page is shown. */
const given = computed(() => {
  if (route.name !== 'relations') return
  const value = route.query.of
  return (Array.isArray(value) ? value[0] : value) ?? ''
})
function open(key: string) {
  void router.replace({ query: { ...route.query, of: key } })
}
async function choose() {
  try {
    const page = await call(
      client.collections.perspectives.$get(
        { query: {} },
        { init: { signal: controller.signal } },
      ),
    )
    const key = defaultCenter(page.items, lastCenter())
    error.value = ''
    if (key && given.value === '') open(key)
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorText(e)
  }
}
watch(
  given,
  (value) => {
    if (value === undefined) return
    if (value) center.value = value
    else void choose()
  },
  { immediate: true },
)
const chosen = computed({
  get: () => (center.value ? [center.value] : []),
  // Picking the account shown again keeps it rather than leaving none.
  set: (value: string[]) => {
    if (value[0]) open(value[0])
  },
})
</script>

<template>
  <div class="relations">
    <div class="picker">
      <PerspectivePicker v-model="chosen" label="中心" single empty="" />
    </div>
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <RelationGraph
      v-if="center"
      :center="center"
      :show-sensitive="showSensitive"
    />
  </div>
</template>

<style scoped>
.picker {
  margin: 0 var(--gutter) 8px;
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
}
.banner {
  margin: 8px var(--gutter);
  font-size: 14px;
  color: var(--destructive);
}
</style>
