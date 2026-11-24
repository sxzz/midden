import { createApp, vaporInteropPlugin } from 'vue'
import App from './App.vue'
import { loadHost } from './host'
import { router } from './router'
import { followShare } from './share'
import './style.css'
// Telegram's script reads the Mini App's launch data from the address, so it
// runs before the router, whose first navigation may rewrite it.
void loadHost().then(() => {
  // Set before the first navigation, which installing the router starts.
  followShare(router)
  const app = createApp(App).use(vaporInteropPlugin).use(router)
  return router.isReady().then(() => app.mount('#app'))
})
