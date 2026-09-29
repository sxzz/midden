<script setup vapor lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import { api, type Collection, type Usage } from '../api'
import { useCollection } from '../composables/useCollection'
import { navigate, useRoute } from '../composables/useRoute'
import { backButton, host } from '../host'
import CollectionDetail from './CollectionDetail.vue'
import CollectionView from './CollectionView.vue'
const showSensitive = shallowRef(false)
const route = useRoute()
const collection = useCollection()
const usage = shallowRef<Usage>()
const { items, next, loading, error } = collection
const id = computed(
  () => /^\/collection\/([a-f0-9-]+)$/.exec(route.value)?.[1] || '',
)
const query = computed(() =>
  route.value.startsWith('/?') ? route.value.slice(2) : '',
)
// Telegram draws its own back button; only stand in for it elsewhere.
const standalone = !host()?.initData
const savedAt = computed(
  () => items.value.find((a) => a.id === id.value)?.saved_at,
)
let loadedQuery: string | undefined
let scroll = 0
let listRoute = '/'
function apiQuery(raw: string) {
  const q = new URLSearchParams(raw)
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
  route,
  async () => {
    backButton(!!id.value)
    if (!id.value) {
      listRoute = route.value
      if (loadedQuery !== query.value) {
        loadedQuery = query.value
        scroll = 0
        await collection.load(apiQuery(query.value))
      }
      await nextTick()
      window.scrollTo(0, scroll)
    } else window.scrollTo(0, 0)
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
function open(id: string) {
  scroll = window.scrollY
  navigate(`/collection/${id}`)
}
function updated(collection: Collection) {
  items.value = items.value.map((a) =>
    a.id === id.value ? { ...collection, saved_at: a.saved_at } : a,
  )
  loadUsage()
}
function deleted(id: string) {
  collection.remove(id)
  navigate(listRoute)
  loadUsage()
}
function search(q: string) {
  loadedQuery = undefined
  navigate(`/${q ? `?${q}` : ''}`)
  if (route.value === `/${q ? `?${q}` : ''}`) collection.load(apiQuery(q))
}
</script>

<template>
  <main class="page">
    <header class="bar">
      <button
        v-if="id && standalone"
        type="button"
        class="back"
        @click="navigate(listRoute)"
      >
        <span class="chevron" aria-hidden="true">‹</span>返回
      </button>
      <h1>{{ id ? '收藏详情' : '我的收藏' }}</h1>
      <button
        type="button"
        class="sensitive-toggle"
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
    <CollectionView
      v-if="!id"
      :items="items"
      :show-sensitive="showSensitive"
      :query="query"
      :loading="loading"
      :error="error"
      :next="next"
      :usage="usage"
      @search="search"
      @open="open"
      @more="collection.more()"
      @retry="collection.load(apiQuery(query))"
    />
    <CollectionDetail
      v-else
      :id="id"
      :key="id"
      :saved-at="savedAt"
      :show-sensitive="showSensitive"
      @deleted="deleted"
      @updated="updated"
    />
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
.sensitive-toggle {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--subtle);
}
.sensitive-toggle[aria-pressed='true'] {
  color: var(--link);
}
.sensitive-toggle:active {
  background: var(--fill);
}
.sensitive-toggle:focus-visible {
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
