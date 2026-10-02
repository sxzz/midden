<script setup vapor lang="ts">
import { onMounted, onUnmounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText } from './api'
import CollectionLibrary from './components/CollectionLibrary.vue'
import TelegramLogin from './components/TelegramLogin.vue'
import AppToast from './components/ui/AppToast.vue'
import CollectionSkeleton from './components/ui/CollectionSkeleton.vue'
import { host, setupHost } from './host'
import { takeWidgetLogin, widgetLogin } from './login'
import { followInternalLink, goBack } from './navigation'
const router = useRouter()
const ready = shallowRef(false)
const error = shallowRef('')
const loading = shallowRef(true)
// Outside Telegram there is no initData; the browser logs in instead.
const browserLogin = shallowRef(false)
let cleanup = () => {}
onMounted(async () => {
  const stopHost = setupHost(() => goBack(router))
  const follow = (event: MouseEvent) => followInternalLink(router, event)
  document.addEventListener('click', follow)
  cleanup = () => {
    stopHost()
    document.removeEventListener('click', follow)
  }
  // Coming back from the Login Widget, sign in before checking the session.
  const login = takeWidgetLogin()
  const loginError = login ? await widgetLogin(login) : ''
  try {
    await api('/session')
    ready.value = true
  } catch {
    const data = host()?.initData
    if (!data) {
      browserLogin.value = true
      error.value = loginError
    } else {
      try {
        await api('/auth/telegram', {
          method: 'POST',
          body: JSON.stringify({ init_data: data }),
        })
        ready.value = true
      } catch (e) {
        error.value = errorText(e)
      }
    }
  } finally {
    loading.value = false
  }
})
onUnmounted(() => cleanup())
</script>

<template>
  <CollectionLibrary v-if="ready" />
  <main v-else class="gate">
    <CollectionSkeleton v-if="loading" />
    <TelegramLogin v-else-if="browserLogin" :error="error" />
    <p v-else role="status">{{ error }}</p>
  </main>
  <AppToast />
</template>

<style scoped>
.gate {
  display: grid;
  width: 100%;
  place-items: center;
  min-height: 100dvh;
  padding: 32px;
}
.gate > [aria-busy] {
  width: 100%;
  max-width: 640px;
}
.gate p {
  margin: 0;
  max-width: 320px;
  text-align: center;
  font-size: 15px;
  line-height: 1.7;
  color: var(--subtle);
}
</style>
