import { createApp, vaporInteropPlugin } from 'vue'
import App from './App.vue'
import { router } from './router'
import { followShare } from './share'
import './style.css'
// Set before the first navigation, which installing the router starts.
followShare(router)
const app = createApp(App).use(vaporInteropPlugin).use(router)
router.isReady().then(() => app.mount('#app'))
