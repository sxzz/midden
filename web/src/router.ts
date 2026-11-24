import { createRouter, createWebHashHistory } from 'vue-router'
import AccountsView from './components/AccountsView.vue'
import CaptureRecordDetail from './components/CaptureRecordDetail.vue'
import CaptureRecords from './components/CaptureRecords.vue'
import CollectionDetail from './components/CollectionDetail.vue'
import CollectionTrends from './components/CollectionTrends.vue'
import CollectionView from './components/CollectionView.vue'

export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'collections', component: CollectionView },
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
    { path: '/accounts', name: 'accounts', component: AccountsView },
    { path: '/captures', name: 'captures', component: CaptureRecords },
    {
      path: '/captures/:id([a-f0-9-]+)',
      name: 'capture',
      component: CaptureRecordDetail,
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
