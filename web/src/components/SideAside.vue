<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client, type CaptureRecord, type Folder } from '../api'
import { filterCardShown, pageAside } from '../aside'
import { recordProgress, recordTitle } from '../captures'
import { useStale } from '../composables/useStale'
import { folderLink } from '../folders'
import { storageSize } from '../presentation'
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
  /** The list's count, on the library's lists. */
  total?: string
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

/**
 * 全站统计: the archive as a whole (GET /v1/library/stats), read when a list
 * is shown and again when its count changes; the server keeps the figures
 * for a minute while nothing is saved or deleted.
 */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const stats = useStale(() =>
  call(client.library.stats.$get({ query: { tz: zone } })),
)
watch(
  () => (lists.value ? (props.total ?? '') : undefined),
  (shown) => {
    if (shown !== undefined) void stats.load()
  },
  { immediate: true },
)
const number = (n: number) => n.toLocaleString('zh-CN')
const figures = computed(() => {
  const s = stats.data.value
  // An answer without the figures (an older server) shows none.
  if (typeof s?.posts !== 'number') return []
  return [
    { label: '帖子', value: number(s.posts) },
    { label: '账号', value: number(s.accounts) },
    { label: '含图片的帖子', value: number(s.with_images) },
    { label: '含视频的帖子', value: number(s.with_videos) },
    { label: '今天新增', value: number(s.saved_today) },
    { label: '本周新增', value: number(s.saved_this_week) },
    { label: '今天采集', value: number(s.captures_today) },
    { label: '今天更新', value: number(s.updates_today) },
  ]
})
onUnmounted(() => {
  ++reading
  clearTimeout(timer)
})
</script>

<template>
  <SidebarFrame
    :search="lists ? undefined : '搜索收藏'"
    query
    :filters="lists"
    @search="search"
  >
    <template v-if="lists">
      <!-- The 筛选 card says the count at its foot; without it, here. -->
      <section
        v-if="total && !filterCardShown"
        class="aside-box"
        aria-label="结果"
      >
        <h2>结果</h2>
        <p class="aside-facts">{{ total }}</p>
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
      <section
        v-if="stats.pending.value || figures.length"
        class="aside-box"
        aria-label="全站统计"
        :aria-busy="stats.pending.value"
      >
        <h2>全站统计</h2>
        <div v-if="stats.pending.value" class="stats">
          <SkeletonBox v-for="n in 8" :key="n" height="38px" />
        </div>
        <template v-else>
          <dl class="stats">
            <div v-for="f in figures" :key="f.label" class="stat">
              <dt>{{ f.label }}</dt>
              <dd>{{ f.value }}</dd>
            </div>
          </dl>
          <p class="aside-facts">
            已用空间 {{ storageSize(stats.data.value!.used_bytes ?? 0) }}
          </p>
        </template>
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
/* Two figures to a line, each a number over its label. */
.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 12px;
  margin: 0;
  padding: 4px 16px 8px;
}
.stat {
  display: flex;
  flex-direction: column-reverse;
  padding: 4px 0;
}
.stat dt {
  font-size: 13px;
  color: var(--subtle);
}
.stat dd {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
/* A running update: its title over its bar. */
.running {
  display: grid;
  gap: 0;
}
</style>
