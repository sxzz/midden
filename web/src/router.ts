import { createRouter, createWebHashHistory } from 'vue-router'
import AccountsView from './components/AccountsView.vue'
import CollectionDetail from './components/CollectionDetail.vue'
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
    { path: '/accounts', name: 'accounts', component: AccountsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
