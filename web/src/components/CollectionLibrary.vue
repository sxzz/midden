<script setup lang="ts">
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import {
  RouterLink,
  RouterView,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router'
import { api, type Collection, type Usage } from '../api'
import { useCollection } from '../composables/useCollection'
import { backButton, host } from '../host'
import { goBack } from '../navigation'
const showSensitive = shallowRef(false)
const route = useRoute()
const router = useRouter()
const collection = useCollection()
const usage = shallowRef<Usage>()
const { items, next, loading, error } = collection
const id = computed(() =>
  route.name === 'collection' ? String(route.params.id) : '',
)
const accounts = computed(() => route.name === 'accounts')
const query = shallowRef('')
// Telegram draws its own back button; only stand in for it elsewhere.
const standalone = !host()?.initData
const savedAt = computed(
  () => items.value.find((a) => a.id === id.value)?.saved_at,
)
let loadedQuery: string | undefined
let listRoute = '/'
// The list plus a few recent details stay alive so going back neither refetches
// nor rebuilds their scroll, order and paging state. Bounded so a long chain of
// profile hops cannot keep every visited detail in memory.
const cachedViews = 6
const removed = shallowRef<string[]>([])
/** Cache identity of a view: one entry for the list, one per collection. */
function viewKey(target: RouteLocationNormalized) {
  if (target.name === 'collections' || target.name === 'accounts')
    return String(target.name)
  const key = String(target.params.id)
  // Returning to a collection we deleted must reload, not show the cached copy.
  return removed.value.includes(key) ? `${key}#removed` : key
}
const scrolls = new Map<string, number>()
function apiQuery(raw: string) {
  const q = new URLSearchParams(raw)
  q.delete('layout')
  const from = q.get('from_date')
  const to = q.get('to_date')
  q.delete('from_date')
  q.delete('to_date')
  if (from) {
    const d = new Date(`${from}T00:00:00`)
    if (Number.isFinite(d.getTime())) q.set('saved_from', d.toISOString())
  }
  if (to) {
    const d = new Date(`${to}T00:00:00`)
    if (Number.isFinite(d.getTime())) {
      d.setDate(d.getDate() + 1)
      q.set('saved_before', d.toISOString())
    }
  }
  return q.toString()
}
watch(
  () => route.fullPath,
  async () => {
    backButton(!!id.value || accounts.value)
    const key = viewKey(route)
    if (!id.value && !accounts.value) {
      listRoute = route.fullPath
      query.value = route.fullPath.split('?')[1]?.split('#')[0] || ''
      const effectiveQuery = apiQuery(query.value)
      if (loadedQuery !== effectiveQuery) {
        loadedQuery = effectiveQuery
        scrolls.set(key, 0)
        await collection.load(effectiveQuery)
      }
    }
    // Wait for the cached view to be reinserted so its height is back.
    await nextTick()
    if (viewKey(route) === key) window.scrollTo(0, scrolls.get(key) || 0)
  },
  { immediate: true },
)
async function loadUsage() {
  try {
    usage.value = await api<Usage>('/usage')
  } catch {
    usage.value = undefined
  }
}
loadUsage()
const removeGuard = router.beforeEach((_to, from) => {
  if (from.name) scrolls.set(viewKey(from), window.scrollY)
})
onUnmounted(removeGuard)
function open(id: string) {
  void router.push({ name: 'collection', params: { id } })
}
function updated(collection: Collection) {
  // Match the collection that finished, not whichever detail is on screen: a
  // capture can report back after the user moved on to another collection.
  items.value = items.value.map((a) =>
    a.id === collection.id ? { ...collection, saved_at: a.saved_at } : a,
  )
  loadUsage()
}
function deleted(id: string) {
  collection.remove(id)
  removed.value = [...removed.value, id]
  scrolls.delete(id)
  void router.push(listRoute)
  loadUsage()
}
function search(q: string) {
  const target = `/${q ? `?${q}` : ''}`
  if (route.fullPath === target) void collection.load(apiQuery(q))
  else void router.push(target)
}
const viewProps = computed(() =>
  accounts.value
    ? {}
    : id.value
      ? {
          savedAt: savedAt.value,
          showSensitive: showSensitive.value,
          onDeleted: deleted,
          onAnnotationsSaved: () => {
            loadedQuery = undefined
          },
          onUpdated: updated,
        }
      : {
          items: items.value,
          showSensitive: showSensitive.value,
          query: query.value,
          loading: loading.value,
          error: error.value,
          next: next.value,
          usage: usage.value,
          onSearch: search,
          onOpen: open,
          onMore: collection.more,
          onRetry: () => collection.load(apiQuery(query.value)),
        },
)
</script>

<template>
  <main class="page">
    <header class="bar">
      <button
        v-if="(id || accounts) && standalone"
        type="button"
        class="back"
        @click="goBack(router)"
      >
        <span class="chevron" aria-hidden="true">‹</span>返回
      </button>
      <h1>{{ accounts ? '采集账号' : id ? '收藏详情' : '我的收藏' }}</h1>
      <RouterLink
        v-if="!id && !accounts"
        to="/accounts"
        class="icon-button accounts-link"
        aria-label="采集账号"
        title="采集账号"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
        </svg>
      </RouterLink>
      <button
        v-if="!accounts"
        type="button"
        class="icon-button sensitive-toggle"
        aria-label="显示敏感内容"
        :aria-pressed="showSensitive"
        :title="showSensitive ? '隐藏敏感内容' : '显示敏感内容'"
        @click="showSensitive = !showSensitive"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          <path v-if="!showSensitive" d="m3 3 18 18" />
        </svg>
      </button>
    </header>
    <RouterView v-slot="{ Component, route: viewRoute }">
      <KeepAlive :max="cachedViews">
        <component
          :is="Component"
          :key="viewKey(viewRoute)"
          v-bind="viewProps"
        />
      </KeepAlive>
    </RouterView>
  </main>
</template>

<style scoped>
.page {
  max-width: 560px;
  margin: 0 auto;
  min-height: 100dvh;
  padding-top: var(--tg-content-safe-area-inset-top, 0px);
  padding-bottom: max(32px, env(safe-area-inset-bottom));
}
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  padding: 10px calc(var(--gutter) + 4px) 2px;
}
.icon-button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--subtle);
}
/* Header actions sit at the trailing edge whichever of them are shown. */
.bar > h1 {
  margin-right: auto;
}
.sensitive-toggle[aria-pressed='true'] {
  color: var(--link);
}
.icon-button:active {
  background: var(--fill);
}
.icon-button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.back {
  display: flex;
  align-items: center;
  min-height: 44px;
  margin-left: -6px;
  padding-right: 8px;
  font-size: 16px;
  color: var(--link);
}
.chevron {
  font-size: 26px;
  line-height: 1;
  padding-right: 2px;
}
h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
</style>
