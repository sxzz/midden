<script setup lang="ts">
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import {
  RouterLink,
  RouterView,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router'
import { APIError, errorText, type PublicShareInfo } from '../api'
import { backButton, host } from '../host'
import { goBack } from '../navigation'
import { readShare } from '../reads'
import ListSection from './ui/ListSection.vue'
// The frame of a public link (分享): what the share opens, then pages of
// what it reaches, read without login. Sensitive media starts covered on
// every visit.
const route = useRoute()
const router = useRouter()
const slug = computed(() => String(route.params.slug ?? ''))
const share = shallowRef<PublicShareInfo>()
const error = shallowRef('')
const showSensitive = shallowRef(false)
let controller = new AbortController()
watch(
  slug,
  async (value) => {
    controller.abort()
    controller = new AbortController()
    const { signal } = controller
    share.value = undefined
    error.value = ''
    if (!value) return
    try {
      const found = await readShare(value, signal)
      if (!signal.aborted) share.value = found
    } catch (e) {
      if (signal.aborted) return
      error.value =
        e instanceof APIError && e.status === 404
          ? '链接不存在或已取消公开'
          : errorText(e)
    }
  },
  { immediate: true },
)
onUnmounted(() => controller.abort())
const nested = computed(() => route.name !== 'share')
watch(nested, (value) => backButton(value), { immediate: true })
const standalone = !host()?.initData
const title = computed(() => {
  if (route.name === 'share-collection-stats') return '统计趋势'
  if (route.name === 'share-collection-changes') return '资料修改记录'
  if (nested.value || share.value?.target === 'collection') return '收藏详情'
  return share.value?.name ?? ''
})
const home = computed(() => ({ name: 'share', params: { slug: slug.value } }))
/** One cached view per page, as in the library. */
function viewKey(target: RouteLocationNormalized) {
  const { slug, id } = target.params
  return `${String(slug)}:${String(target.name)}:${String(id ?? '')}`
}
const scrolls = new Map<string, number>()
const removeGuard = router.beforeEach((_to, from) => {
  if (from.meta.public) scrolls.set(viewKey(from), window.scrollY)
})
onUnmounted(removeGuard)
watch(
  () => route.fullPath,
  async () => {
    const key = viewKey(route)
    await nextTick()
    if (viewKey(route) === key) window.scrollTo(0, scrolls.get(key) || 0)
  },
)
const viewProps = computed(() =>
  route.name === 'share'
    ? { share: share.value, showSensitive: showSensitive.value }
    : route.name === 'share-collection-stats'
      ? {}
      : { showSensitive: showSensitive.value },
)
</script>

<template>
  <main class="page">
    <header class="bar" :class="{ nested }">
      <RouterLink
        v-if="nested"
        :to="home"
        class="icon-button"
        aria-label="Home"
        title="返回首页"
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
          <path d="M4 10.5 12 4l8 6.5" />
          <path d="M6 9v11h12V9" />
          <path d="M10 20v-6h4v6" />
        </svg>
      </RouterLink>
      <button
        v-if="nested && standalone"
        type="button"
        class="back"
        @click="goBack(router)"
      >
        <span class="chevron" aria-hidden="true">‹</span>返回
      </button>
      <h1>{{ title }}</h1>
      <button
        v-if="route.name !== 'share-collection-stats'"
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
    <ListSection v-if="error" plain>
      <p class="banner" role="alert">{{ error }}</p>
    </ListSection>
    <RouterView v-else v-slot="{ Component, route: viewRoute }">
      <KeepAlive :max="7">
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
  max-width: 960px;
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
.bar.nested {
  padding-bottom: 12px;
}
.bar > .icon-button:first-child {
  margin-left: -11px;
}
.bar > h1 {
  margin-right: auto;
}
.icon-button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--subtle);
}
.icon-button:active {
  background: var(--fill);
}
.icon-button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.sensitive-toggle[aria-pressed='true'] {
  color: var(--link);
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.banner {
  margin: 0;
  padding: 14px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
  line-height: 1.5;
}
</style>
