import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
} from 'vue-router'
import CaptureRecordDetail from './components/CaptureRecordDetail.vue'
import CaptureRecords from './components/CaptureRecords.vue'
import CollectionDetail from './components/CollectionDetail.vue'
import CollectionHistory from './components/CollectionHistory.vue'
import CollectionView from './components/CollectionView.vue'
import PasskeySetup from './components/PasskeySetup.vue'
import PublicHome from './components/PublicHome.vue'
import SettingsView from './components/SettingsView.vue'
import WatchesView from './components/WatchesView.vue'
import { settingsSections } from './settings-sections'
import type { HistoryTab } from './share'

// The graph page brings sigma and graphology: loaded only when opened.
const RelationGraph = () => import('./components/RelationGraph.vue')
const RelationCompare = () => import('./components/RelationCompare.vue')
const RelationsView = () => import('./components/RelationsView.vue')

const SHARE = String.raw`/s/:slug([\w-]+)`
// 设置's entries, by the sections that have them; SettingsView shows the
// section for an entry of another.
const ENTRY_SECTIONS = settingsSections
  .filter((s) => s.entries)
  .map((s) => s.value)
  .join('|')
const ENTRIES = settingsSections
  .flatMap((s) => s.entries ?? [])
  .map((e) => e.value)
  .join('|')
// Pages inside a share take the collection; the slug is the share's own.
const idOnly = (route: RouteLocationNormalized) => ({
  id: String(route.params.id),
})
/** A tab of 历史: the collection, and which tab the address opens. */
const historyTab = (tab: HistoryTab) => (route: RouteLocationNormalized) => ({
  id: String(route.params.id),
  tab,
})

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'collections', component: CollectionView },
    // A folder is the library list under its saved filter; the address
    // carries the filter shown, so a changed one survives a reload.
    {
      path: '/folder/:id([a-f0-9-]+)',
      name: 'folder',
      component: CollectionView,
    },
    {
      path: '/collection/:id([a-f0-9-]+)',
      name: 'collection',
      component: CollectionDetail,
      props: true,
    },
    // 历史 of an account, one tab per address (CollectionHistory): 资料,
    // 数据 and 关注; a post has 数据 alone.
    {
      path: '/collection/:id([a-f0-9-]+)/history',
      name: 'collection-history',
      component: CollectionHistory,
      props: historyTab('profile'),
    },
    {
      path: '/collection/:id([a-f0-9-]+)/history/data',
      name: 'collection-history-data',
      component: CollectionHistory,
      props: historyTab('data'),
    },
    {
      path: '/collection/:id([a-f0-9-]+)/history/follows',
      name: 'collection-history-follows',
      component: CollectionHistory,
      props: historyTab('follows'),
    },
    {
      path: '/collection/:id([a-f0-9-]+)/graph',
      name: 'collection-graph',
      component: RelationGraph,
      props: true,
    },
    // Several accounts' relations side by side; the owner's alone.
    { path: '/compare', name: 'compare', component: RelationCompare },
    // The 关系 tab: the graph of any account with relation data (`of`).
    { path: '/relations', name: 'relations', component: RelationsView },
    // 设置 as X has it (settings-sections.ts): a list of sections, a section
    // with its entries, an entry. On a wide window one view shows the list
    // beside what is chosen; on a narrow one each is a page below the last.
    { path: '/settings', name: 'settings', component: SettingsView },
    {
      path: '/settings/:section(passkeys|tokens|admin|about)',
      name: 'settings-section',
      component: SettingsView,
    },
    {
      path: `/settings/:section(${ENTRY_SECTIONS})/:entry(${ENTRIES})`,
      name: 'settings-entry',
      component: SettingsView,
    },
    // 采集's tabs: the records, and 定期更新; the capture accounts open over
    // either as a dialog (`?dialog=accounts`).
    { path: '/captures', name: 'captures', component: CaptureRecords },
    {
      path: '/captures/watches',
      name: 'captures-watches',
      component: WatchesView,
    },
    {
      path: '/captures/:id([a-f0-9-]+)',
      name: 'capture',
      component: CaptureRecordDetail,
      props: true,
    },
    // A public link: no login, only what the share reaches. PublicShare
    // (shown by App instead of the library) frames these pages.
    {
      path: SHARE,
      name: 'share',
      component: PublicHome,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)`,
      name: 'share-collection',
      component: CollectionDetail,
      props: idOnly,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/history`,
      name: 'share-collection-history',
      component: CollectionHistory,
      props: historyTab('profile'),
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/history/data`,
      name: 'share-collection-history-data',
      component: CollectionHistory,
      props: historyTab('data'),
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/history/follows`,
      name: 'share-collection-history-follows',
      component: CollectionHistory,
      props: historyTab('follows'),
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/graph`,
      name: 'share-collection-graph',
      component: RelationGraph,
      props: idOnly,
      meta: { public: true },
    },
    // A /passkey link from the bot: registers a passkey without signing in.
    // App shows it in place of the library.
    {
      // The token is in the fragment (`/passkey#<token>`), which no server
      // and no log sees.
      path: '/passkey',
      name: 'passkey',
      component: PasskeySetup,
      meta: { setup: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
