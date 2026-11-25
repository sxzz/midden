import {
  createRouter,
  createWebHashHistory,
  type RouteLocationNormalized,
} from 'vue-router'
import AccountsView from './components/AccountsView.vue'
import AdminView from './components/AdminView.vue'
import CaptureRecordDetail from './components/CaptureRecordDetail.vue'
import CaptureRecords from './components/CaptureRecords.vue'
import CollectionDetail from './components/CollectionDetail.vue'
import CollectionTrends from './components/CollectionTrends.vue'
import CollectionView from './components/CollectionView.vue'
import FollowChanges from './components/FollowChanges.vue'
import PasskeyList from './components/PasskeyList.vue'
import PasskeySetup from './components/PasskeySetup.vue'
import ProfileChanges from './components/ProfileChanges.vue'
import PublicHome from './components/PublicHome.vue'
import SettingsView from './components/SettingsView.vue'

// The graph page brings sigma and graphology: loaded only when opened.
const RelationGraph = () => import('./components/RelationGraph.vue')
const RelationCompare = () => import('./components/RelationCompare.vue')
const RelationsView = () => import('./components/RelationsView.vue')
const StorageView = () => import('./components/StorageView.vue')

const SHARE = String.raw`/s/:slug([\w-]+)`
// Pages inside a share take the collection; the slug is the share's own.
const idOnly = (route: RouteLocationNormalized) => ({
  id: String(route.params.id),
})

export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
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
    {
      path: '/collection/:id([a-f0-9-]+)/stats',
      name: 'collection-stats',
      component: CollectionTrends,
      props: true,
    },
    {
      path: '/collection/:id([a-f0-9-]+)/changes',
      name: 'collection-changes',
      component: ProfileChanges,
      props: true,
    },
    {
      path: '/collection/:id([a-f0-9-]+)/follows',
      name: 'collection-follows',
      component: FollowChanges,
      props: true,
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
    { path: '/settings', name: 'settings', component: SettingsView },
    {
      path: '/settings/accounts',
      name: 'settings-accounts',
      component: AccountsView,
    },
    {
      path: '/settings/passkeys',
      name: 'settings-passkeys',
      component: PasskeyList,
    },
    { path: '/settings/admin', name: 'settings-admin', component: AdminView },
    // Its charts load with it, not with the app.
    {
      path: '/settings/admin/storage',
      name: 'settings-storage',
      component: StorageView,
    },
    { path: '/captures', name: 'captures', component: CaptureRecords },
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
      path: `${SHARE}/collection/:id([a-f0-9-]+)/stats`,
      name: 'share-collection-stats',
      component: CollectionTrends,
      props: idOnly,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/follows`,
      name: 'share-collection-follows',
      component: FollowChanges,
      props: idOnly,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/graph`,
      name: 'share-collection-graph',
      component: RelationGraph,
      props: idOnly,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/changes`,
      name: 'share-collection-changes',
      component: ProfileChanges,
      props: idOnly,
      meta: { public: true },
    },
    // A /passkey link from the bot: registers a passkey without signing in.
    // App shows it in place of the library.
    {
      path: String.raw`/passkey/:token([\w-]+)`,
      name: 'passkey',
      component: PasskeySetup,
      meta: { setup: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
