<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pageAside } from '../aside'
import { folderQuery } from '../folders'
import { buildFacts, REPOSITORY } from '../settings'
import { tabOf } from '../tabbar'
import AsideDetail from './AsideDetail.vue'
import AppLink from './ui/AppLink.vue'
import type { Folder } from '../api'
// The desktop sidebar from 1280px (layout.ts), beside the page as X has
// it: a search of the library, then what goes with the page shown, then
// the small print.
const props = defineProps<{
  folders: Folder[]
  /** The list's count and the space used, on the library's lists. */
  total?: string
  storage?: string
}>()
const route = useRoute()
const router = useRouter()
/** The library's lists have their own search box, as X's 探索 does. */
const lists = computed(
  () => route.name === 'collections' || route.name === 'folder',
)
const text = shallowRef('')
function search() {
  const q = text.value.trim()
  if (!q) return
  void router.push({ name: 'collections', query: { q } })
  text.value = ''
}
const folderLink = (folder: Folder) => {
  const query = folderQuery(folder.filter)
  return `/folder/${folder.id}${query ? `?${query}` : ''}`
}
const detail = computed(() =>
  route.name === 'collection' && pageAside.value?.id === route.params.id
    ? pageAside.value
    : undefined,
)
const settingsPages = [
  { name: 'settings-accounts', label: '采集账号' },
  { name: 'settings-passkeys', label: '通行密钥' },
  { name: 'settings-watches', label: '定期更新' },
  { name: 'settings-admin', label: '管理员面板' },
  { name: 'settings-storage', label: '存储用量' },
  { name: 'settings-jobs', label: '后台任务' },
]
const settings = computed(() => tabOf(route.name) === 'settings')
const about = buildFacts(__BUILD_VERSION__, __BUILD_TIME__)
const folderShown = computed(() =>
  route.name === 'folder' ? String(route.params.id) : '',
)
const facts = computed(() =>
  [props.total, props.storage].filter(Boolean).join(' · '),
)
</script>

<template>
  <aside class="aside" aria-label="侧栏">
    <div class="sticky">
      <form v-if="!lists" class="search" role="search" @submit.prevent="search">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l4.5 4.5" />
        </svg>
        <input
          v-model="text"
          type="search"
          placeholder="搜索收藏"
          aria-label="搜索收藏"
          maxlength="500"
          enterkeyhint="search"
        />
      </form>
      <div class="content">
        <template v-if="lists">
          <section v-if="facts" class="aside-box" aria-label="结果">
            <h2>结果</h2>
            <p class="facts">{{ facts }}</p>
          </section>
          <section v-if="folders.length" class="aside-box" aria-label="收藏夹">
            <h2>收藏夹</h2>
            <AppLink
              v-for="folder in folders"
              :key="folder.id"
              class="folder"
              :class="{ on: folder.id === folderShown }"
              :to="folderLink(folder)"
              :aria-current="folder.id === folderShown ? 'page' : undefined"
            >
              <span class="folder-name">{{ folder.name }}</span>
              <span class="folder-count">{{
                folder.count.toLocaleString('zh-CN')
              }}</span>
            </AppLink>
          </section>
        </template>
        <AsideDetail v-else-if="detail" :detail="detail" />
        <nav v-else-if="settings" class="aside-box" aria-label="设置的页面">
          <h2>设置</h2>
          <AppLink
            v-for="page in settingsPages"
            :key="page.name"
            class="folder"
            :class="{ on: route.name === page.name }"
            :to="{ name: page.name }"
            :aria-current="route.name === page.name ? 'page' : undefined"
          >
            <span class="folder-name">{{ page.label }}</span>
          </AppLink>
        </nav>
      </div>
      <footer class="footer">
        <AppLink v-if="about.commitURL" :href="about.commitURL"
          >版本 {{ about.version }}</AppLink
        >
        <span v-else>版本 {{ about.version }}</span>
        <AppLink :href="REPOSITORY">源代码</AppLink>
        <AppLink :to="{ name: 'settings' }">设置</AppLink>
      </footer>
    </div>
  </aside>
</template>

<style>
/* The sidebar's boxes, shared with AsideDetail. */
.aside-box {
  display: block;
  margin: 0 0 16px;
  padding: 0 0 8px;
  border-radius: 16px;
  background: var(--card);
  overflow: hidden;
}
.aside-box > h2 {
  margin: 0;
  padding: 12px 16px 6px;
  font-size: 19px;
  font-weight: 800;
  line-height: 1.3;
}
.aside-more {
  display: block;
  padding: 9px 16px;
  font-size: 14px;
  color: var(--link);
}
.aside-more:hover {
  background: var(--fill);
}
</style>

<style scoped>
/* 350px wide, 30px from the column, as X's. */
.aside {
  flex: none;
  width: 350px;
  margin-left: 30px;
}
/* The sidebar stays in view; a long one scrolls on its own. */
.sticky {
  position: sticky;
  top: 0;
  max-height: 100dvh;
  padding-bottom: 32px;
  overflow-y: auto;
  scrollbar-width: none;
}
.search {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  padding: 6px 0 6px;
  background: var(--page);
  color: var(--subtle);
}
.search svg {
  position: absolute;
  left: 16px;
  pointer-events: none;
}
.search input {
  width: 100%;
  height: 42px;
  padding: 0 16px 0 44px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 15px;
}
.search input:focus {
  outline: none;
  border-color: var(--link);
  background: var(--page);
}
.search input::placeholder {
  color: var(--subtle);
}
.content {
  padding-top: 12px;
}
.search + .content {
  padding-top: 0;
}
.facts {
  margin: 0;
  padding: 2px 16px 6px;
  font-size: 14px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.folder {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  color: var(--text);
  font-size: 15px;
}
.folder:hover {
  background: var(--fill);
}
.folder.on {
  font-weight: 700;
}
.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-count {
  flex: none;
  font-size: 13px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 0 16px;
  font-size: 13px;
  color: var(--subtle);
}
.footer a {
  color: var(--subtle);
}
.footer a:hover {
  text-decoration: underline;
}
</style>
