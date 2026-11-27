<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client, type CaptureRecord, type Folder } from '../api'
import { pageAside } from '../aside'
import { recordProgress, recordTitle } from '../captures'
import { useStale } from '../composables/useStale'
import { folderLink } from '../folders'
import { listQuery } from '../reads'
import { buildFacts, REPOSITORY } from '../settings'
import AsideDetail from './AsideDetail.vue'
import SidebarFrame from './SidebarFrame.vue'
import AppLink from './ui/AppLink.vue'
import SkeletonBox from './ui/SkeletonBox.vue'
// The owner's sidebar from 1000px (layout.ts): a search of the library,
// then what goes with the page shown (nothing on 设置, whose sections are
// all in the column), then the small print.
const props = defineProps<{
  folders: Folder[]
  /** The list's count and the space used, on the library's lists. */
  total?: string
  storage?: string
  /**
   * The shown list's API query while it lists posts: its top hashtags and
   * authors are counted over it.
   */
  posts?: string
  /** The list's address with a hashtag or an author added to its filter. */
  refine?: (key: 'q' | 'author', value: string) => string
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
const detail = computed(() =>
  route.name === 'collection' && pageAside.value?.id === route.params.id
    ? pageAside.value
    : undefined,
)
const about = buildFacts(__BUILD_VERSION__, __BUILD_TIME__)
const folderShown = computed(() =>
  route.name === 'folder' ? String(route.params.id) : '',
)
const facts = computed(() =>
  [props.total, props.storage].filter(Boolean).join(' · '),
)

/** The top 10 of the list's posts by `by`, as the agent API counts them. */
const TOP = '10'
const aggregate = (by: 'hashtag' | 'author') =>
  call(
    client.collections.aggregate.$get({
      query: {
        ...listQuery(new URLSearchParams(props.posts)),
        by,
        limit: TOP,
      },
    }),
  )
const hashtags = useStale(() => aggregate('hashtag'))
const authors = useStale(() => aggregate('author'))
watch(
  () => props.posts,
  (query) => {
    if (query === undefined) return
    void hashtags.load()
    void authors.load()
  },
  { immediate: true },
)
type Bucket = Awaited<ReturnType<typeof aggregate>>['buckets'][number]
const tagRows = computed(() =>
  (hashtags.data.value?.buckets ?? []).flatMap((b: Bucket) =>
    typeof b.key === 'string' ? [{ tag: `#${b.key}`, count: b.count }] : [],
  ),
)
const authorRows = computed(() =>
  (authors.data.value?.buckets ?? []).flatMap((b: Bucket) => {
    if (typeof b.key !== 'string') return []
    const name = typeof b.name === 'string' ? b.name : ''
    const handle = typeof b.handle === 'string' ? `@${b.handle}` : ''
    return [
      { key: b.key, name: name || handle || '账号', handle, count: b.count },
    ]
  }),
)

/**
 * Updates running now, from the records' first page: read when a list is
 * shown, again every few seconds while any runs, and now and then after.
 */
const RUNNING_POLL = 5000
const IDLE_POLL = 30_000
const running = shallowRef<CaptureRecord[]>([])
let timer: ReturnType<typeof setTimeout> | undefined
let reading = 0
async function readRunning() {
  clearTimeout(timer)
  const n = ++reading
  if (!lists.value) return
  try {
    const page = await call(client.captures.$get({ query: {} }))
    if (n === reading)
      running.value = page.items.filter((r) => r.update && !r.done)
  } catch {
    // The box keeps what it showed; the next reading may answer.
  }
  if (n === reading && lists.value)
    timer = setTimeout(
      readRunning,
      running.value.length ? RUNNING_POLL : IDLE_POLL,
    )
}
watch(lists, readRunning, { immediate: true })
onUnmounted(() => {
  ++reading
  clearTimeout(timer)
})
</script>

<template>
  <SidebarFrame :search="lists ? undefined : '搜索收藏'" query @search="search">
    <template v-if="lists">
      <section v-if="facts" class="aside-box" aria-label="结果">
        <h2>结果</h2>
        <p class="aside-facts">{{ facts }}</p>
      </section>
      <section
        v-if="running.length"
        class="aside-box"
        aria-label="进行中的更新"
      >
        <h2>进行中的更新</h2>
        <AppLink
          v-for="r in running"
          :key="r.id"
          class="aside-row running"
          :to="{ name: 'capture', params: { id: r.id } }"
        >
          <span class="aside-row-name">{{ recordTitle(r) }}</span>
          <progress
            class="aside-progress"
            :value="recordProgress(r)"
            max="1"
            :aria-label="`${recordTitle(r)} 进度`"
          />
        </AppLink>
      </section>
      <template v-if="posts !== undefined && refine">
        <section
          v-if="hashtags.pending.value || tagRows.length"
          class="aside-box"
          aria-label="热门话题"
          :aria-busy="hashtags.pending.value"
        >
          <h2>热门话题</h2>
          <div v-if="hashtags.pending.value" class="skeleton-rows">
            <SkeletonBox v-for="n in 4" :key="n" height="14px" width="60%" />
          </div>
          <AppLink
            v-for="row in tagRows"
            :key="row.tag"
            class="aside-row"
            :to="refine('q', row.tag)"
            :title="`在当前列表中搜索 ${row.tag}`"
          >
            <span class="aside-row-name hashtag">{{ row.tag }}</span>
            <span class="aside-row-count">{{
              row.count.toLocaleString('zh-CN')
            }}</span>
          </AppLink>
        </section>
        <section
          v-if="authors.pending.value || authorRows.length"
          class="aside-box"
          aria-label="常见作者"
          :aria-busy="authors.pending.value"
        >
          <h2>常见作者</h2>
          <div v-if="authors.pending.value" class="skeleton-rows">
            <SkeletonBox v-for="n in 4" :key="n" height="14px" width="70%" />
          </div>
          <AppLink
            v-for="row in authorRows"
            :key="row.key"
            class="aside-row"
            :to="refine('author', row.key)"
            :title="`只看${row.name}的帖子`"
          >
            <span class="aside-row-name"
              >{{ row.name
              }}<small
                v-if="row.handle && row.handle !== row.name"
                class="handle"
              >
                {{ row.handle }}</small
              ></span
            >
            <span class="aside-row-count">{{
              row.count.toLocaleString('zh-CN')
            }}</span>
          </AppLink>
        </section>
      </template>
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
            folder.count?.toLocaleString('zh-CN')
          }}</span>
        </AppLink>
      </section>
    </template>
    <AsideDetail v-else-if="detail" :detail="detail" />
    <template #footer>
      <AppLink v-if="about.commitURL" :href="about.commitURL"
        >版本{{ about.version }}</AppLink
      >
      <span v-else>版本{{ about.version }}</span>
      <AppLink :href="REPOSITORY">源代码</AppLink>
      <AppLink :to="{ name: 'settings' }">设置</AppLink>
    </template>
  </SidebarFrame>
</template>

<style scoped>
/* A hashtag is one word: no gap after its # before the script. */
.hashtag {
  text-autospace: no-autospace;
}
.skeleton-rows {
  display: grid;
  gap: 14px;
  padding: 10px 16px 12px;
}
.handle {
  margin-left: 4px;
  font-size: 13px;
  color: var(--subtle);
}
/* A running update: its title over its bar. */
.running {
  display: grid;
  gap: 0;
}
</style>
