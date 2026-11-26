<script setup lang="ts">
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import {
  RouterLink,
  RouterView,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router'
import {
  call,
  client,
  errorText,
  type Collection,
  type Folder,
  type TagChange,
  type Usage,
  type Watch,
} from '../api'
import { pageAside } from '../aside'
import { useCollection } from '../composables/useCollection'
import { useFolders } from '../composables/useFolders'
import { toast } from '../composables/useToast'
import { useWatch } from '../composables/useWatch'
import {
  apiQuery,
  folderAddress,
  folderFilter,
  folderKinds,
  folderModified,
  folderQuery,
  hasFilters,
  KINDS,
  listTab,
  tabKind,
  type Kind,
  type ListTab,
} from '../folders'
import { backButton, host } from '../host'
import { FULL, RAIL, useMedia } from '../layout'
import { mediaRemovals } from '../media-removals'
import { listsProfiles, present, storageSize } from '../presentation'
import { listQuery } from '../reads'
import { isProfileEntity } from '../relations'
import { restoreScroll } from '../scroll-restore'
import { forgetPages, lastPage, leftScroll, tabStates } from '../tab-state'
import { tabOf as barTabOf, tabs as barTabs, isTabRoot } from '../tabbar'
import { detailTitle, setDocumentTitle } from '../titles'
import CaptureSheet from './CaptureSheet.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import FolderMenuSheet from './FolderMenuSheet.vue'
import FolderNameSheet from './FolderNameSheet.vue'
import FolderStrip from './FolderStrip.vue'
import ShareSheet from './ShareSheet.vue'
import SideAside from './SideAside.vue'
import SideRail from './SideRail.vue'
import TabBar from './TabBar.vue'
import BackLink from './ui/BackLink.vue'
import UpdateSheet from './UpdateSheet.vue'
import WatchSheet from './WatchSheet.vue'
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
const kindLabels: Record<Kind, string> = { post: '帖子', profile: '账号' }
/**
 * A folder holds posts and accounts alike; each is its own list, and the
 * tabs only show when its results have both. Which one is shown is a view
 * choice (`tab` in the address), never part of the folder's filter.
 */
const folderKindsShown = shallowRef<Kind[]>([])
const folderKind = shallowRef<Kind>('post')
/** Counts by entity type for the last filter the open folder showed. */
let counted: { filter: string; types: Record<string, number> } | undefined
const all = [...Object.values(lists), folderList]
/** A route, shown or only resolved (a tab's last page). */
type ViewRoute = Pick<RouteLocationNormalized, 'fullPath' | 'params'> & {
  name?: RouteLocationNormalized['name'] | null
}
const queryOf = (target: ViewRoute) =>
  target.fullPath.split('?')[1]?.split('#')[0] || ''
function tabOf(target: ViewRoute): Tab {
  return listTab(queryOf(target))
}
const tab = computed(() => tabOf(route))
const id = computed(() =>
  route.name === 'collection' ? String(route.params.id) : '',
)
const folderId = computed(() =>
  route.name === 'folder' ? String(route.params.id) : '',
)
const captures = computed(() => route.name === 'captures')
const capture = computed(() => route.name === 'capture')
const stats = computed(() => route.name === 'collection-stats')
const changes = computed(() => route.name === 'collection-changes')
const follows = computed(() => route.name === 'collection-follows')
const graphPage = computed(() => route.name === 'collection-graph')
const comparePage = computed(() => route.name === 'compare')
const relationsPage = computed(() => route.name === 'relations')
const adminPage = computed(() => route.name === 'settings-admin')
/** The library's own lists: 探索's root. */
const home = computed(() => route.name === 'collections')
/** Any page below a tab's root, which back returns from. */
const nested = computed(() => !isTabRoot(route.name))
const {
  folders,
  loaded: foldersLoaded,
  error: foldersError,
  load: loadFolders,
  create: createFolder,
  update: updateFolder,
  remove: removeFolder,
  retag: retagFolders,
} = useFolders()
const folder = computed(() =>
  folders.value.find((f) => f.id === folderId.value),
)
/** The open folder's 定期更新, named in its menu. */
const { trailing: watchTrailing, changed: watchSaved } = useWatch(() =>
  folderId.value ? { target: 'folder', id: folderId.value } : undefined,
)
function watchChanged(w: Watch | undefined) {
  watchSaved(w)
  sheet.value = ''
}
const titles: Record<string, string> = {
  collections: '我的收藏',
  captures: '采集',
  capture: '采集记录',
  'collection-stats': '统计趋势',
  'collection-changes': '资料修改记录',
  'collection-follows': '关注变化',
  'collection-graph': '关系图谱',
  compare: '关系对比',
  relations: '关系',
  settings: '设置',
  'settings-accounts': '采集账号',
  'settings-passkeys': '通行密钥',
  'settings-watches': '定期更新',
  'settings-admin': '管理员面板',
  'settings-storage': '存储用量',
  'settings-jobs': '后台任务',
}
const title = computed(() => {
  if (folderId.value) return folder.value?.name || '收藏夹'
  if (id.value) {
    const listed = all
      .flatMap(({ collection }) => collection.items.value)
      .find((item) => item.id === id.value)
    return detailTitle(id.value, listed)
  }
  return titles[String(route.name)] || '我的收藏'
})
watch(title, (value) => setDocumentTitle(value), { immediate: true })
/** Settings and capture records have no media to cover. */
const sensitiveShown = computed(
  () =>
    barTabOf(route.name) !== 'settings' &&
    !captures.value &&
    !capture.value &&
    !stats.value,
)
/**
 * The desktop layout (layout.ts): the rail in the bottom bar's place, and
 * from 1280px the sidebar. Relation graphs need the room more than a
 * sidebar would fill it: there the column takes the sidebar's width too.
 */
const wide = useMedia(RAIL)
const full = useMedia(FULL)
const roomy = computed(
  () => graphPage.value || comparePage.value || relationsPage.value,
)
const sidebar = computed(() => full.value && !roomy.value)
const capturing = shallowRef(false)
/** The shown list's count, for the header's second line and the sidebar. */
const shownTotal = computed(() => {
  if (!home.value && !folderId.value) return ''
  const list = folderId.value ? folderList : lists[tab.value]
  const total = list.collection.total.value
  return total === undefined
    ? ''
    : `${total.toLocaleString('zh-CN')} ${listsProfiles(list.query.value) ? '个账号' : '条'}`
})
const usedText = computed(() =>
  usage.value ? `已用 ${storageSize(usage.value.used_bytes)}` : '',
)
/** Under the title on a desktop, as X's header gives a count or a handle. */
const subtitle = computed(() => {
  if (shownTotal.value) return shownTotal.value
  const detail = pageAside.value
  const graph = detail?.collection?.graph
  const root = graph?.entities.find((entity) => entity.key === graph.root)
  if (!id.value || detail?.id !== id.value || !isProfileEntity(root)) return ''
  const handle = present(detail.collection!).handle
  return handle ? `@${handle}` : ''
})
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
// Both lists, each tab's root and the page it was left on, plus a few recent
// details stay alive, so going back or switching tabs neither refetches nor
// rebuilds their scroll, order and paging state. Bounded so a long chain of
// profile hops cannot keep every visited detail in memory.
const cachedViews = 10
const removed = shallowRef<string[]>([])
/** Cache identity of a view: one entry per list tab, one per collection. */
function viewKey(target: ViewRoute) {
  if (target.name === 'collections') return `collections:${tabOf(target)}`
  if (target.name === 'folder') return 'folder'
  // Pages without parameters are one view each.
  if (
    typeof target.name === 'string' &&
    (target.name === 'captures' ||
      target.name === 'relations' ||
      target.name.startsWith('settings'))
  )
    return target.name
  if (target.name === 'capture') return `capture:${String(target.params.id)}`
  if (target.name === 'collection-stats')
    return `stats:${String(target.params.id)}`
  if (target.name === 'collection-changes')
    return `changes:${String(target.params.id)}`
  if (target.name === 'collection-follows')
    return `follows:${String(target.params.id)}`
  if (target.name === 'collection-graph')
    return `graph:${String(target.params.id)}`
  if (target.name === 'compare') return 'compare'
  const key = String(target.params.id)
  // Returning to a collection we deleted must reload, not show the cached copy.
  return removed.value.includes(key) ? `${key}#removed` : key
}
const scrolls = new Map<string, number>()
/**
 * Where each tab's last page was scrolled when the app was last open in this
 * browser tab (see tab-state): used once, when the page is first shown.
 */
const leftAt = new Map<string, number>()
for (const { value } of barTabs) {
  const states = tabStates.value
  const target = router.resolve(lastPage(states, value))
  const y = leftScroll(states, value, target.fullPath)
  if (y) leftAt.set(viewKey(target), y)
}
/** Show the list for the address, loading it unless already shown. */
async function show(
  list: ReturnType<typeof createList>,
  key: string,
  query = queryOf(route),
  effectiveQuery = apiQuery(query, tabKind(tab.value)),
) {
  listRoute = list.path = route.fullPath
  list.query.value = query
  if (list.loadedQuery !== effectiveQuery) {
    list.loadedQuery = effectiveQuery
    scrolls.set(key, 0)
    await list.collection.load(effectiveQuery)
  }
}
/** The kinds a folder filter's results hold. */
async function kindsFor(filter: string, saved: Folder): Promise<Kind[]> {
  // The folders were just loaded with their own counts.
  if (filter === saved.filter) return folderKinds(saved.types)
  if (counted?.filter !== filter) {
    const q = new URLSearchParams(filter)
    try {
      const { types } = await call(
        client.collections.count.$get({
          query: listQuery(q),
        }),
      )
      counted = { filter, types }
    } catch {
      // Unknown, so both tabs stay available.
      return KINDS
    }
  }
  return folderKinds(counted.types)
}
/** Show the open folder's list for the address, on the tab it asks for. */
async function showFolder(saved: Folder, key: string) {
  const address = queryOf(route)
  const kinds = await kindsFor(folderFilter(address), saved)
  if (viewKey(route) !== key || queryOf(route) !== address) return false
  const asked = new URLSearchParams(address).get('tab')
  const kind = kinds.find((k) => k === asked) ?? kinds[0] ?? 'post'
  folderKindsShown.value = kinds
  folderKind.value = kind
  // The view and the filters read the kind from the query they are given.
  const shown = new URLSearchParams(address)
  shown.set('tab', kind)
  await show(folderList, key, shown.toString(), apiQuery(address, kind))
  return true
}
function folderTabLink(kind: Kind) {
  const q = new URLSearchParams(queryOf(route))
  q.set('tab', kind)
  return `/folder/${folderId.value}?${q}`
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
    const left = leftAt.get(key)
    leftAt.delete(key)
    if (home.value) {
      if (arrived) void loadFolders()
      await show(lists[tab.value], key)
    } else if (folderId.value) {
      if (arrived) {
        counted = undefined
        folderKindsShown.value = []
      }
      if (arrived || !foldersLoaded.value) await loadFolders()
      const saved = folder.value
      if (!saved || viewKey(route) !== key) return
      // A bare folder address (a bookmark) shows the folder's filter.
      const query = new URLSearchParams(queryOf(route))
      const layout = query.get('layout')
      const shownTab = query.get('tab')
      query.delete('layout')
      query.delete('tab')
      if (!query.size) {
        const target = new URLSearchParams(folderQuery(saved.filter))
        if (layout) target.set('layout', layout)
        if (shownTab) target.set('tab', shownTab)
        void router.replace(`/folder/${saved.id}?${target}`)
        return
      }
      if (!(await showFolder(saved, key))) return
    }
    // Wait for the cached view to be reinserted so its height is back.
    await nextTick()
    if (viewKey(route) === key) restoreScroll(left ?? scrolls.get(key) ?? 0)
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
function updated(collection: Collection) {
  // Match the collection that finished, not whichever detail is on screen: a
  // capture can report back after the user moved on to another collection.
  for (const { collection: list } of all)
    list.items.value = list.items.value.map((a) =>
      a.id === collection.id ? { ...collection, saved_at: a.saved_at } : a,
    )
  loadUsage()
}
/**
 * Collections are gone. Their accounts' posts may have gone with them, and
 * which ones only the server knows: then every list reloads.
 */
function forget(ids: string[], withPosts: boolean) {
  for (const { collection } of all) for (const id of ids) collection.remove(id)
  counted = undefined
  removed.value = [...removed.value, ...ids]
  for (const id of ids) scrolls.delete(id)
  forgetPages((path) => ids.some((id) => path.startsWith(`/collection/${id}`)))
  if (withPosts) stale()
  loadUsage()
}
function deleted(id: string, withPosts: boolean) {
  forget([id], withPosts)
  void router.push(listRoute)
}
function search(q: string) {
  let target = `/${q ? `?${q}` : ''}`
  if (folderId.value) target = `/folder/${folderId.value}?${folderAddress(q)}`
  if (route.fullPath === target) {
    const list = folderId.value ? folderList : lists[tab.value]
    if (list.loadedQuery !== undefined)
      void list.collection.load(list.loadedQuery)
  } else void router.push(target)
}
/** What the lists hold changed; reload them when they are next shown. */
function stale() {
  for (const list of all) list.loadedQuery = undefined
  counted = undefined
}
// Media removed from the viewer, which opens from every list: the list shown
// loads again, the others when next shown.
watch(mediaRemovals, () => {
  const shown = folderId.value ? folderList : lists[tab.value]
  const query = shown.loadedQuery
  stale()
  if (query !== undefined) {
    shown.loadedQuery = query
    void shown.collection.load(query)
  }
  loadUsage()
})
// Captures change what the lists hold.
function saved() {
  stale()
  loadUsage()
}
/** Lists filtered on an edited tag hold other items now. */
function tagsChanged(change: TagChange) {
  if (change.to?.id !== change.from) retagFolders(change.from, change.to?.id)
  stale()
  void loadFolders()
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
const canSave = computed(() => home.value && hasFilters(shownQuery.value))
type Sheet =
  '' | 'create' | 'menu' | 'rename' | 'delete' | 'share' | 'update' | 'watch'
const sheet = shallowRef<Sheet>('')
const busy = shallowRef(false)
const sheetError = shallowRef('')
function openSheet(value: Sheet) {
  sheetError.value = ''
  sheet.value = value
}
/** Records of the folder updates started here, by folder. */
const folderRecords = shallowRef<Record<string, string>>({})
function folderUpdated(recordId: string) {
  const current = folder.value
  sheet.value = ''
  if (current)
    folderRecords.value = { ...folderRecords.value, [current.id]: recordId }
}
/**
 * Save what the list shows as a new folder, and continue inside it on the
 * kind shown.
 */
async function saveFolder(name: string) {
  busy.value = true
  sheetError.value = ''
  const query = shownQuery.value
  const kind = folderId.value ? folderKind.value : tabKind(tab.value)
  try {
    const created = await createFolder(name, folderFilter(query))
    sheet.value = ''
    toast('已存为收藏夹')
    const address = new URLSearchParams(folderQuery(created.filter))
    const layout = new URLSearchParams(query).get('layout')
    if (layout) address.set('layout', layout)
    address.set('tab', kind)
    const target = `/folder/${created.id}?${address}`
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
    toast('已保存条件')
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
    void router.push(
      lists[folderKind.value === 'profile' ? 'x.profile' : 'x.post'].path,
    )
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
function listProps(list: ReturnType<typeof createList>, error = '') {
  const { collection, query } = list
  return {
    items: collection.items.value,
    showSensitive: showSensitive.value,
    query: query.value,
    loading: collection.loading.value,
    error: error || collection.error.value,
    next: collection.next.value,
    total: collection.total.value,
    usage: usage.value,
    onSearch: search,
    onTagsChanged: tagsChanged,
    onMore: collection.more,
    onRetry: () => {
      if (list.loadedQuery !== undefined) void collection.load(list.loadedQuery)
    },
    onDeleted: (ids: string[], withPosts: boolean) => {
      const shown = list.loadedQuery
      forget(ids, withPosts)
      if (withPosts && shown !== undefined) {
        list.loadedQuery = shown
        void collection.load(shown)
      }
    },
    // Sizes changed, and sorting by them may reorder the list.
    onMediaRemoved: () => {
      if (list.loadedQuery !== undefined) void collection.load(list.loadedQuery)
      loadUsage()
    },
  }
}
const viewProps = computed(() => {
  if (adminPage.value)
    return {
      onCleared: () => {
        for (const { collection } of all) collection.items.value = []
        saved()
      },
    }
  if (captures.value || capture.value) return { onSaved: saved }
  if (stats.value || barTabOf(route.name) === 'settings') return {}
  if (
    changes.value ||
    follows.value ||
    graphPage.value ||
    comparePage.value ||
    relationsPage.value
  )
    return { showSensitive: showSensitive.value }
  if (id.value)
    return {
      savedAt: savedAt.value,
      showSensitive: showSensitive.value,
      onDeleted: deleted,
      onRemoved: forget,
      onAnnotationsSaved: stale,
      onUpdated: updated,
    }
  if (folderId.value) {
    const missing = foldersLoaded.value && !folder.value
    const props = listProps(
      folderList,
      missing ? foldersError.value || '收藏夹不存在或已删除' : '',
    )
    // Not this folder's items: another folder's, or none to show. Until its
    // tabs are known, it is loading.
    if (missing || folderList.path !== route.fullPath)
      Object.assign(props, {
        items: [],
        next: '',
        total: undefined,
        loading: !missing,
      })
    Object.assign(props, { folder: true })
    if (missing) props.onRetry = loadFolders
    return props
  }
  return listProps(lists[tab.value])
})
</script>

<template>
  <SideRail v-if="wide" @capture="capturing = true" />
  <main class="page" :class="{ roomy }">
    <header class="bar" :class="{ spaced: !home }">
      <!-- On a desktop an arrow, as X's header has it. -->
      <BackLink
        v-if="nested && standalone && wide"
        class="icon-button back-arrow"
        aria-label="返回"
        title="返回"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
      </BackLink>
      <BackLink v-else-if="nested && standalone" class="back">
        <span class="chevron" aria-hidden="true">‹</span>返回
      </BackLink>
      <div v-if="wide" class="heading">
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
      </div>
      <h1 v-else>{{ title }}</h1>
      <!-- Capturing adds to the library, so it opens from 探索; the rail
         has its own 采集. -->
      <RouterLink
        v-if="home && !wide"
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
        v-if="sensitiveShown"
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
    <div v-if="home" class="tabs" role="tablist" aria-label="类型">
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
    <FolderStrip v-if="home" :folders="folders" />
    <div
      v-if="folderId && folderKindsShown.length > 1"
      class="tabs"
      role="tablist"
      aria-label="类型"
    >
      <RouterLink
        v-for="kind in folderKindsShown"
        :key="kind"
        role="tab"
        class="tab"
        :class="{ on: folderKind === kind }"
        :aria-selected="folderKind === kind"
        :to="folderTabLink(kind)"
        replace
      >
        {{ kindLabels[kind] }}
      </RouterLink>
    </div>
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
        保存条件
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
      :progress="folderRecords[folder.id]"
      :watching="watchTrailing"
      @update="openSheet('update')"
      @watch="openSheet('watch')"
      @navigate="sheet = ''"
      @share="openSheet('share')"
      @rename="openSheet('rename')"
      @delete="openSheet('delete')"
      @cancel="sheet = ''"
    />
    <UpdateSheet
      v-if="folder"
      :open="sheet === 'update'"
      :target="{ target: 'folder', id: folder.id }"
      @started="folderUpdated"
      @cancel="sheet = ''"
    />
    <WatchSheet
      v-if="folder"
      :open="sheet === 'watch'"
      :target="{ target: 'folder', id: folder.id }"
      :label="`收藏夹「${folder.name}」`"
      @changed="watchChanged"
      @navigate="sheet = ''"
      @cancel="sheet = ''"
    />
    <ShareSheet
      v-if="folder"
      :id="folder.id"
      :open="sheet === 'share'"
      target="folder"
      :title="`公开分享收藏夹「${folder.name}」`"
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
    <TabBar v-if="!wide" />
  </main>
  <SideAside
    v-if="sidebar"
    :folders="folders"
    :total="shownTotal"
    :storage="usedText"
  />
  <CaptureSheet v-if="wide" :open="capturing" @close="capturing = false" />
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  min-height: 100dvh;
  padding-top: var(--tg-content-safe-area-inset-top, 0px);
  /* The bottom bar's room, and some more so the end does not touch it. */
  padding-bottom: calc(var(--tab-bar-space, 16px) + 16px);
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
/* Pages other than the lists start with a section, which needs room from
   the bar. */
.bar.spaced {
  padding-bottom: 12px;
}
/* Header actions sit at the trailing edge whichever of them are shown. */
.bar > h1,
.heading {
  margin-right: auto;
}
.heading {
  min-width: 0;
}
.subtitle {
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.3;
  color: var(--subtle);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.back-arrow {
  margin: 0 12px 0 -10px;
  color: var(--text);
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
/* The desktop layout (layout.ts), X's: the rail, a 600px column between
   thin lines, the sidebar, centred together (App's .shell). The column's
   header stays at the top as the page scrolls. */
@media (min-width: 700px) {
  .page {
    flex: 0 1 600px;
    min-width: 0;
    max-width: 600px;
    margin: 0;
    box-shadow:
      -1px 0 0 var(--separator),
      1px 0 0 var(--separator);
  }
  /* A graph takes the sidebar's room as well. */
  .page.roomy {
    flex-basis: 980px;
    max-width: 980px;
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
  .bar.spaced {
    padding-bottom: 4px;
  }
  .icon-button:hover {
    background: var(--fill);
  }
  .bar h1 {
    font-size: 19px;
    font-weight: 700;
  }
}
</style>
