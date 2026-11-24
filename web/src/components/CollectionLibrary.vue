<script setup lang="ts">
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import {
  RouterLink,
  RouterView,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router'
import { call, client, errorText, type Collection, type Usage } from '../api'
import { useCollection } from '../composables/useCollection'
import { useFolders } from '../composables/useFolders'
import { toast } from '../composables/useToast'
import {
  apiQuery,
  folderFilter,
  folderModified,
  folderQuery,
  hasFilters,
  listTab,
  withTab,
  type ListTab,
} from '../folders'
import { backButton, host } from '../host'
import { goBack } from '../navigation'
import ConfirmSheet from './ConfirmSheet.vue'
import FolderMenuSheet from './FolderMenuSheet.vue'
import FolderNameSheet from './FolderNameSheet.vue'
import FolderStrip from './FolderStrip.vue'
// Remembered in this browser, so a reload does not cover the media again.
const SENSITIVE_KEY = 'midden.showSensitive'
const showSensitive = shallowRef(readFlag(SENSITIVE_KEY))
watch(showSensitive, (on) => writeFlag(SENSITIVE_KEY, on))
function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // Storage can be off; the choice then lasts until the page reloads.
  }
}
const route = useRoute()
const router = useRouter()
const usage = shallowRef<Usage>()
// Posts and accounts are separate lists: each tab keeps its own filters,
// results and paging, so switching between them costs nothing.
const tabs = [
  { value: 'x.post', label: '帖子' },
  { value: 'x.profile', label: '账号' },
] as const
type Tab = ListTab
const createList = (path: string) => ({
  collection: useCollection(),
  /** Where the tab was left, filters included. */
  path,
  query: shallowRef(''),
  loadedQuery: undefined as string | undefined,
})
const lists: Record<Tab, ReturnType<typeof createList>> = {
  'x.post': createList('/'),
  'x.profile': createList('/?entity_type=x.profile,instagram.profile'),
}
/** The open folder's list; one at a time, so opening another reloads it. */
const folderList = createList('')
const all = [...Object.values(lists), folderList]
const queryOf = (target: RouteLocationNormalized) =>
  target.fullPath.split('?')[1]?.split('#')[0] || ''
function tabOf(target: RouteLocationNormalized): Tab {
  return listTab(queryOf(target))
}
const tab = computed(() => tabOf(route))
const id = computed(() =>
  route.name === 'collection' ? String(route.params.id) : '',
)
const folderId = computed(() =>
  route.name === 'folder' ? String(route.params.id) : '',
)
const accounts = computed(() => route.name === 'accounts')
const captures = computed(() => route.name === 'captures')
const capture = computed(() => route.name === 'capture')
const stats = computed(() => route.name === 'collection-stats')
const changes = computed(() => route.name === 'collection-changes')
/** Any page reached from the library, which is where back returns to. */
const nested = computed(
  () =>
    !!id.value ||
    !!folderId.value ||
    accounts.value ||
    captures.value ||
    capture.value ||
    stats.value ||
    changes.value,
)
const {
  folders,
  loaded: foldersLoaded,
  error: foldersError,
  load: loadFolders,
  create: createFolder,
  update: updateFolder,
  remove: removeFolder,
} = useFolders()
const folder = computed(() =>
  folders.value.find((f) => f.id === folderId.value),
)
const title = computed(() =>
  accounts.value
    ? '采集账号'
    : captures.value
      ? '采集'
      : capture.value
        ? '采集记录'
        : stats.value
          ? '统计趋势'
          : changes.value
            ? '资料修改记录'
            : id.value
              ? '收藏详情'
              : folderId.value
                ? folder.value?.name || '收藏夹'
                : '我的收藏',
)
// Telegram draws its own back button; only stand in for it elsewhere.
const standalone = !host()?.initData
const savedAt = computed(() => {
  for (const { collection } of all) {
    const found = collection.items.value.find((a) => a.id === id.value)
    if (found) return found.saved_at
  }
  return undefined
})
let listRoute = '/'
// Both lists plus a few recent details stay alive so going back neither
// refetches nor rebuilds their scroll, order and paging state. Bounded so a long
// chain of profile hops cannot keep every visited detail in memory.
const cachedViews = 7
const removed = shallowRef<string[]>([])
/** Cache identity of a view: one entry per list tab, one per collection. */
function viewKey(target: RouteLocationNormalized) {
  if (target.name === 'collections') return `collections:${tabOf(target)}`
  if (target.name === 'folder') return 'folder'
  if (target.name === 'accounts') return 'accounts'
  if (target.name === 'captures') return 'captures'
  if (target.name === 'capture') return `capture:${String(target.params.id)}`
  if (target.name === 'collection-stats')
    return `stats:${String(target.params.id)}`
  if (target.name === 'collection-changes')
    return `changes:${String(target.params.id)}`
  const key = String(target.params.id)
  // Returning to a collection we deleted must reload, not show the cached copy.
  return removed.value.includes(key) ? `${key}#removed` : key
}
const scrolls = new Map<string, number>()
/** Show the list for the address, loading it unless already shown. */
async function show(list: ReturnType<typeof createList>, key: string) {
  listRoute = list.path = route.fullPath
  list.query.value = queryOf(route)
  const effectiveQuery = apiQuery(list.query.value, tab.value)
  if (list.loadedQuery !== effectiveQuery) {
    list.loadedQuery = effectiveQuery
    scrolls.set(key, 0)
    await list.collection.load(effectiveQuery)
  }
}
let shownKey = ''
watch(
  () => route.fullPath,
  async () => {
    backButton(nested.value)
    const key = viewKey(route)
    // Counts change with what was saved meanwhile; a list shown again
    // refreshes them, filtering within it does not.
    const arrived = key !== shownKey
    shownKey = key
    if (!nested.value) {
      if (arrived) void loadFolders()
      await show(lists[tab.value], key)
    } else if (folderId.value) {
      if (arrived || !foldersLoaded.value) await loadFolders()
      const saved = folder.value
      if (!saved || viewKey(route) !== key) return
      // A bare folder address (a bookmark) shows the folder's filter.
      const query = new URLSearchParams(queryOf(route))
      const layout = query.get('layout')
      query.delete('layout')
      if (!query.size) {
        const target = new URLSearchParams(folderQuery(saved.filter))
        if (layout) target.set('layout', layout)
        void router.replace(`/folder/${saved.id}?${target}`)
        return
      }
      await show(folderList, key)
    }
    // Wait for the cached view to be reinserted so its height is back.
    await nextTick()
    if (viewKey(route) === key) window.scrollTo(0, scrolls.get(key) || 0)
  },
  { immediate: true },
)
async function loadUsage() {
  try {
    usage.value = await call(client.usage.$get())
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
  for (const { collection: list } of all)
    list.items.value = list.items.value.map((a) =>
      a.id === collection.id ? { ...collection, saved_at: a.saved_at } : a,
    )
  loadUsage()
}
function deleted(id: string) {
  for (const { collection } of all) collection.remove(id)
  removed.value = [...removed.value, id]
  scrolls.delete(id)
  void router.push(listRoute)
  loadUsage()
}
function search(q: string) {
  let target = `/${q ? `?${q}` : ''}`
  if (folderId.value) {
    // An empty query would mean the folder's own filter, so the tab's entity
    // types stay in it, which changes nothing the list shows.
    target = `/folder/${folderId.value}?${withTab(q, tab.value)}`
  }
  if (route.fullPath === target) {
    const list = folderId.value ? folderList : lists[tab.value]
    void list.collection.load(apiQuery(q, tab.value))
  } else void router.push(target)
}
// Captures change what the lists hold; reload them when they are next shown.
function saved() {
  for (const list of all) list.loadedQuery = undefined
  loadUsage()
}
/** What the current list shows, as an address query. */
const shownQuery = computed(() =>
  folderId.value ? folderList.query.value : lists[tab.value].query.value,
)
const modified = computed(
  () =>
    !!folder.value &&
    !!folderList.query.value &&
    folderModified(folderList.query.value, folder.value.filter),
)
const canSave = computed(() => !nested.value && hasFilters(shownQuery.value))
const listFolders = computed(() =>
  folders.value.filter((f) => listTab(f.filter) === tab.value),
)
type Sheet = '' | 'create' | 'menu' | 'rename' | 'delete'
const sheet = shallowRef<Sheet>('')
const busy = shallowRef(false)
const sheetError = shallowRef('')
function openSheet(value: Sheet) {
  sheetError.value = ''
  sheet.value = value
}
/** Save what the list shows as a new folder, and continue inside it. */
async function saveFolder(name: string) {
  busy.value = true
  sheetError.value = ''
  const query = shownQuery.value
  try {
    const created = await createFolder(name, folderFilter(query))
    sheet.value = ''
    toast('已存为收藏夹')
    const target = `/folder/${created.id}?${withTab(query, tab.value)}`
    if (folderId.value) void router.replace(target)
    else void router.push(target)
  } catch (e) {
    sheetError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function updateFilter() {
  const current = folder.value
  if (!current || busy.value) return
  busy.value = true
  try {
    await updateFolder(current.id, {
      filter: folderFilter(folderList.query.value),
    })
    toast('已更新收藏夹')
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function rename(name: string) {
  const current = folder.value
  if (!current) return
  busy.value = true
  sheetError.value = ''
  try {
    await updateFolder(current.id, { name })
    sheet.value = ''
  } catch (e) {
    sheetError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function deleteFolder() {
  const current = folder.value
  if (!current) return
  busy.value = true
  try {
    await removeFolder(current.id)
    sheet.value = ''
    toast('已删除收藏夹')
    void router.push(lists[listTab(current.filter)].path)
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
function listProps(list: ReturnType<typeof createList>, error = '') {
  const type = tab.value
  const { collection, query } = list
  return {
    items: collection.items.value,
    showSensitive: showSensitive.value,
    query: query.value,
    loading: collection.loading.value,
    error: error || collection.error.value,
    next: collection.next.value,
    usage: usage.value,
    onSearch: search,
    onOpen: open,
    onMore: collection.more,
    onRetry: () => collection.load(apiQuery(query.value, type)),
  }
}
const viewProps = computed(() => {
  if (accounts.value)
    return {
      onCleared: () => {
        for (const { collection } of all) collection.items.value = []
        saved()
      },
    }
  if (captures.value || capture.value) return { onSaved: saved }
  if (stats.value) return {}
  if (changes.value) return { showSensitive: showSensitive.value }
  if (id.value)
    return {
      savedAt: savedAt.value,
      showSensitive: showSensitive.value,
      onDeleted: deleted,
      onAnnotationsSaved: () => {
        for (const list of all) list.loadedQuery = undefined
      },
      onUpdated: updated,
    }
  if (folderId.value) {
    const missing = foldersLoaded.value && !folder.value
    const props = listProps(
      folderList,
      missing ? foldersError.value || '收藏夹不存在或已删除' : '',
    )
    // Not this folder's items: another folder's, or none to show.
    if (missing || folderList.path !== route.fullPath)
      Object.assign(props, { items: [], next: '' })
    if (missing) props.onRetry = loadFolders
    return props
  }
  return listProps(lists[tab.value])
})
</script>

<template>
  <main class="page">
    <header class="bar" :class="{ nested }">
      <RouterLink
        v-if="nested"
        to="/"
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
      <RouterLink
        v-if="!nested"
        to="/captures"
        class="icon-button captures-link"
        aria-label="采集"
        title="采集"
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
          <path d="M12 4v11" />
          <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
          <path d="M5 20h14" />
        </svg>
      </RouterLink>
      <RouterLink
        v-if="!nested"
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
        v-if="folder"
        type="button"
        class="icon-button"
        aria-label="管理收藏夹"
        title="管理收藏夹"
        @click="openSheet('menu')"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
      <button
        v-if="!accounts && !captures && !capture && !stats"
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
    <div v-if="!nested" class="tabs" role="tablist" aria-label="类型">
      <RouterLink
        v-for="option in tabs"
        :key="option.value"
        role="tab"
        class="tab"
        :class="{ on: tab === option.value }"
        :aria-selected="tab === option.value"
        :to="lists[option.value].path"
      >
        {{ option.label }}
      </RouterLink>
    </div>
    <FolderStrip v-if="!nested" :folders="listFolders" />
    <div v-if="modified" class="folder-status" role="status">
      <span class="folder-status-text">筛选条件已修改</span>
      <button type="button" :disabled="busy" @click="openSheet('create')">
        另存为
      </button>
      <button
        type="button"
        class="primary"
        :disabled="busy"
        @click="updateFilter"
      >
        更新收藏夹
      </button>
    </div>
    <RouterView v-slot="{ Component, route: viewRoute }">
      <KeepAlive :max="cachedViews">
        <component :is="Component" :key="viewKey(viewRoute)" v-bind="viewProps">
          <template v-if="canSave" #actions>
            <button type="button" @click="openSheet('create')">
              存为收藏夹
            </button>
          </template>
        </component>
      </KeepAlive>
    </RouterView>
    <FolderNameSheet
      :open="sheet === 'create'"
      :title="folder ? '另存为收藏夹' : '存为收藏夹'"
      confirm-label="保存"
      :busy="busy"
      :error="sheetError"
      @submit="saveFolder"
      @cancel="sheet = ''"
    />
    <FolderNameSheet
      v-if="folder"
      :open="sheet === 'rename'"
      title="重命名收藏夹"
      confirm-label="保存"
      :name="folder.name"
      :busy="busy"
      :error="sheetError"
      @submit="rename"
      @cancel="sheet = ''"
    />
    <FolderMenuSheet
      v-if="folder"
      :open="sheet === 'menu'"
      :name="folder.name"
      @rename="openSheet('rename')"
      @delete="openSheet('delete')"
      @cancel="sheet = ''"
    />
    <ConfirmSheet
      v-if="folder"
      :open="sheet === 'delete'"
      :title="`删除收藏夹「${folder.name}」`"
      description="收藏夹中的收藏不会被删除。"
      confirm-label="删除收藏夹"
      :busy="busy"
      @confirm="deleteFolder"
      @cancel="sheet = ''"
    />
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
.icon-button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--subtle);
}
/* Inner pages start with a section title, which needs room from the bar. */
.bar.nested {
  padding-bottom: 12px;
}
/* The home glyph, not its tap target, lines up with the text below. */
.bar > .icon-button:first-child {
  margin-left: -11px;
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
.tabs {
  display: flex;
  gap: 2px;
  margin: 4px var(--gutter) 12px;
  padding: 2px;
  border-radius: 10px;
  background: var(--fill);
}
.tab {
  flex: 1;
  /* Tabs are links now, so centre the label vertically ourselves. */
  display: grid;
  place-items: center;
  min-height: 32px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--subtle);
  transition:
    background 160ms ease,
    color 160ms ease;
}
.tab.on {
  background: var(--card);
  color: var(--text);
  /* The ring keeps it apart in dark themes, where the card is darker than
     the track. */
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.12);
}
.tab:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 1px;
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
/* A changed folder says so above its filters, with what can be done. */
.folder-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 var(--gutter) 12px;
  padding: 8px 8px 8px 14px;
  border-radius: var(--radius);
  background: var(--card);
  font-size: 14px;
}
.folder-status-text {
  margin-right: auto;
  color: var(--subtle);
}
.folder-status button {
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  color: var(--link);
  background: var(--fill);
}
.folder-status .primary {
  font-weight: 600;
}
.folder-status button:disabled {
  opacity: 0.5;
}
.folder-status button:active:not(:disabled) {
  opacity: 0.7;
}
</style>
