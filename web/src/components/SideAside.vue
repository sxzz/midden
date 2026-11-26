<script setup vapor lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pageAside } from '../aside'
import { folderQuery } from '../folders'
import { buildFacts, REPOSITORY } from '../settings'
import { tabOf } from '../tabbar'
import AsideDetail from './AsideDetail.vue'
import SidebarFrame from './SidebarFrame.vue'
import AppLink from './ui/AppLink.vue'
import type { Folder } from '../api'
// The owner's sidebar from 1000px (layout.ts): a search of the library,
// then what goes with the page shown, then the small print.
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
function search(q: string) {
  void router.push({ name: 'collections', query: { q } })
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
  <SidebarFrame :search="lists ? undefined : '搜索收藏'" @search="search">
    <template v-if="lists">
      <section v-if="facts" class="aside-box" aria-label="结果">
        <h2>结果</h2>
        <p class="aside-facts">{{ facts }}</p>
      </section>
      <section v-if="folders.length" class="aside-box" aria-label="收藏夹">
        <h2>收藏夹</h2>
        <AppLink
          v-for="folder in folders"
          :key="folder.id"
          class="aside-row"
          :to="folderLink(folder)"
          :aria-current="folder.id === folderShown ? 'page' : undefined"
        >
          <span class="aside-row-name">{{ folder.name }}</span>
          <span class="aside-row-count">{{
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
        class="aside-row"
        :to="{ name: page.name }"
        :aria-current="route.name === page.name ? 'page' : undefined"
      >
        <span class="aside-row-name">{{ page.label }}</span>
      </AppLink>
    </nav>
    <template #footer>
      <AppLink v-if="about.commitURL" :href="about.commitURL"
        >版本 {{ about.version }}</AppLink
      >
      <span v-else>版本 {{ about.version }}</span>
      <AppLink :href="REPOSITORY">源代码</AppLink>
      <AppLink :to="{ name: 'settings' }">设置</AppLink>
    </template>
  </SidebarFrame>
</template>
