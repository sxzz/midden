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
import { headerRefresh } from '../header-actions'
import { backButton, host } from '../host'
import { SIDEBAR, useMedia } from '../layout'
import { readShare } from '../reads'
import { detailTitle, kindOf, setDocumentTitle } from '../titles'
import ShareAside from './ShareAside.vue'
import BackLink from './ui/BackLink.vue'
import ListSection from './ui/ListSection.vue'
import RefreshButton from './ui/RefreshButton.vue'
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
/**
 * From 700px the page is the column between thin lines, and from 1000px
 * the share's sidebar sits beside it (layout.ts); a visitor has no rail. A
 * graph takes the sidebar's room instead.
 */
const graph = computed(() => route.name === 'share-collection-graph')
const sidebarRoom = useMedia(SIDEBAR)
const sidebar = computed(() => sidebarRoom.value && !graph.value)
const history = computed(() =>
  String(route.name ?? '').startsWith('share-collection-history'),
)
/** 数据, the counts, has no media to cover. */
const counts = computed(() => route.name === 'share-collection-history-data')
const title = computed(() => {
  // An account's 历史; a post's is its counts alone (CollectionHistory).
  if (history.value)
    return kindOf(String(route.params.id)) === 'post' ? '统计趋势' : '历史'
  if (route.name === 'share-collection-graph') return '关系图谱'
  if (nested.value) return detailTitle(String(route.params.id))
  if (share.value?.target === 'collection')
    return detailTitle(share.value.collection_id ?? '')
  return share.value?.name ?? ''
})
watch(title, (value) => setDocumentTitle(value), { immediate: true })
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
    : { showSensitive: showSensitive.value },
)
</script>

<template>
  <main class="page" :class="{ roomy: graph }">
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
      <BackLink v-if="nested && standalone" class="back">
        <span class="chevron" aria-hidden="true">‹</span>返回
      </BackLink>
      <h1>{{ title }}</h1>
      <RefreshButton
        v-if="headerRefresh"
        class="header-refresh"
        :busy="headerRefresh.busy"
        @refresh="headerRefresh.refresh()"
      />
      <button
        v-if="!counts"
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
  <ShareAside v-if="sidebar && !error" :share="share" />
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  min-height: 100dvh;
  /* Nothing in the column widens the page sideways: a word or box too
     wide for it is cut at its edge. Unlike hidden, this leaves the column
     no scroller, so its header still sticks to the window. */
  overflow-x: clip;
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
/* 刷新 for a page with no toolbar of its own (header-actions.ts), as the
   header's other icons. */
.bar > .header-refresh {
  width: 44px;
  height: 44px;
  color: var(--subtle);
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
/* The desktop column, as the owner's (CollectionLibrary), centred with the
   sidebar by App's .shell. */
@media (min-width: 700px) {
  .page {
    /* Where what sticks under the header (PageTabs) stops. */
    --page-header-height: 53px;
    flex: 0 1 var(--column-width);
    min-width: 0;
    max-width: var(--column-width);
    margin: 0;
    box-shadow:
      -1px 0 0 var(--separator),
      1px 0 0 var(--separator);
  }
  .page.roomy {
    flex-basis: var(--column-roomy-width);
    max-width: var(--column-roomy-width);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    min-height: 53px;
    margin-bottom: 8px;
    padding: 4px calc(var(--gutter) + 4px);
    background: color-mix(in srgb, var(--page) 85%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    backdrop-filter: saturate(180%) blur(12px);
  }
  .bar.nested {
    padding-bottom: 4px;
  }
  .bar h1 {
    font-size: 19px;
    font-weight: 700;
  }
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
