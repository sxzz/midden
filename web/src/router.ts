import { createRouter, createWebHashHistory } from 'vue-router'
import AccountsView from './components/AccountsView.vue'
import CaptureRecordDetail from './components/CaptureRecordDetail.vue'
import CaptureRecords from './components/CaptureRecords.vue'
import CollectionDetail from './components/CollectionDetail.vue'
import CollectionTrends from './components/CollectionTrends.vue'
import CollectionView from './components/CollectionView.vue'
import FollowChanges from './components/FollowChanges.vue'
import ProfileChanges from './components/ProfileChanges.vue'
import PublicHome from './components/PublicHome.vue'

const SHARE = String.raw`/s/:slug([\w-]+)`

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
    { path: '/accounts', name: 'accounts', component: AccountsView },
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
      props: true,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/stats`,
      name: 'share-collection-stats',
      component: CollectionTrends,
      props: true,
      meta: { public: true },
    },
    {
      path: `${SHARE}/collection/:id([a-f0-9-]+)/changes`,
      name: 'share-collection-changes',
      component: ProfileChanges,
      props: true,
      meta: { public: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
