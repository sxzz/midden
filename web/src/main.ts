import { createApp, vaporInteropPlugin } from 'vue'
import App from './App.vue'
import { loadHost } from './host'
import { followShare } from './share'
import { trackTabs } from './tab-state'
import './style.css'
// Telegram's script reads the Mini App's launch data from the address, and
// creating the router already rewrites it (`#tgWebAppData=…` becomes
// `#/tgWebAppData=…`), so the router module loads only after the script.
void loadHost()
  .then(() => import('./router'))
  .then(({ router }) => {
    // Set before the first navigation, which installing the router starts.
    followShare(router)
    trackTabs(router)
    const app = createApp(App).use(vaporInteropPlugin).use(router)
    return router.isReady().then(() => app.mount('#app'))
  })
