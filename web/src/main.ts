import { createApp, vaporInteropPlugin } from 'vue'
import { legacyAddress } from './app-path'
import App from './App.vue'
import { loadHost } from './host'
import { followShare } from './share'
import { trackInput } from './sheet-focus'
import { trackTabs } from './tab-state'
import './style.css'
// An old address (`/#/captures`, from a bookmark, an old share link or
// an old bot message) becomes the address it means now, before anything
// reads it. Any other fragment is left alone: Telegram's launch data.
const legacy = legacyAddress(location.hash)
if (legacy !== undefined) history.replaceState(history.state, '', legacy)
// Sheets start focus by what opened them (sheet-focus.ts).
trackInput()
// Telegram's script reads the Mini App's launch data from the address
// (`#tgWebAppData=…`), so the router loads only after the script.
void loadHost()
  .then(() => import('./router'))
  .then(({ router }) => {
    // Set before the first navigation, which installing the router starts.
    followShare(router)
    trackTabs(router)
    const app = createApp(App).use(vaporInteropPlugin).use(router)
    return router.isReady().then(() => app.mount('#app'))
  })
