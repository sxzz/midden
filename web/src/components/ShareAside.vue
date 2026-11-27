<script setup vapor lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { pageAside } from '../aside'
import { present } from '../presentation'
import { REPOSITORY } from '../settings'
import { detailTitle } from '../titles'
import AsideDetail from './AsideDetail.vue'
import SidebarFrame from './SidebarFrame.vue'
import AppLink from './ui/AppLink.vue'
import type { PublicShareInfo } from '../api'
// A public link's sidebar from 1000px (layout.ts): what the link shares,
// a search within a shared folder, and the shown collection's summary. A
// visitor reads only what the page itself may show.
const props = defineProps<{ share?: PublicShareInfo }>()
const route = useRoute()
const router = useRouter()
const slug = computed(() => String(route.params.slug ?? ''))
const home = computed(() => ({ name: 'share', params: { slug: slug.value } }))
const folder = computed(() => props.share?.target === 'folder')
/** The folder's list has a search box of its own. */
const search = computed(() =>
  folder.value && route.name !== 'share' ? '在分享中搜索' : undefined,
)
function find(q: string) {
  void router.push({ ...home.value, query: { q } })
}
/** The collection shown: the shared one on the link's page, or one below. */
const shownId = computed(() =>
  route.name === 'share'
    ? props.share?.collection_id
    : route.name === 'share-collection'
      ? String(route.params.id)
      : undefined,
)
const detail = computed(() =>
  shownId.value && pageAside.value?.id === shownId.value
    ? pageAside.value
    : undefined,
)
const shared = computed(() => {
  const share = props.share
  if (!share) return undefined
  if (share.target === 'folder')
    return {
      name: share.name ?? '',
      facts: [
        '收藏夹',
        share.posts && `${share.posts.toLocaleString('zh-CN')}条帖子`,
        share.profiles && `${share.profiles.toLocaleString('zh-CN')}个账号`,
      ],
    }
  const id = share.collection_id ?? ''
  const own =
    pageAside.value?.id === id ? pageAside.value.collection : undefined
  const shown = own && present(own)
  return {
    name: shown?.name || detailTitle(id),
    lang: shown?.name ? shown.nameLang : undefined,
    facts: [detailTitle(id), shown?.handle && `@${shown.handle}`],
  }
})
</script>

<template>
  <SidebarFrame
    :search="search"
    :filters="folder && route.name === 'share'"
    @search="find"
  >
    <section v-if="shared" class="aside-box" aria-label="公开分享">
      <h2 :lang="shared.lang">{{ shared.name }}</h2>
      <p class="aside-facts">
        {{ shared.facts.filter(Boolean).join(' · ') }}
      </p>
      <AppLink v-if="route.name !== 'share'" class="aside-more" :to="home"
        >分享首页</AppLink
      >
    </section>
    <AsideDetail v-if="detail" :detail="detail" />
    <template #footer>
      <AppLink :href="REPOSITORY">Midden</AppLink>
    </template>
  </SidebarFrame>
</template>
