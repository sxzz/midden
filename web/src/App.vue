<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client, errorText } from './api'
import CollectionLibrary from './components/CollectionLibrary.vue'
import PublicShare from './components/PublicShare.vue'
import TelegramLogin from './components/TelegramLogin.vue'
import AppToast from './components/ui/AppToast.vue'
import CollectionSkeleton from './components/ui/CollectionSkeleton.vue'
import { host, loadHost, setupHost } from './host'
import { takeWidgetLogin, widgetLogin } from './login'
import { followInternalLink, goBack } from './navigation'
const router = useRouter()
const route = useRoute()
// A public link is read without logging in; the library asks for it only
// once one of its own pages is shown.
const shared = computed(() => !!route.meta.public)
const ready = shallowRef(false)
const error = shallowRef('')
const loading = shallowRef(true)
// Outside Telegram there is no initData; the browser logs in instead.
const browserLogin = shallowRef(false)
let cleanup = () => {}
onMounted(() => {
  const stopHost = setupHost(() => goBack(router))
  const follow = (event: MouseEvent) => followInternalLink(router, event)
  document.addEventListener('click', follow)
  cleanup = () => {
    stopHost()
    document.removeEventListener('click', follow)
  }
  let started = false
  watch(
    shared,
    (value) => {
      if (value || started) return
      started = true
      void signIn()
    },
    { immediate: true },
  )
})
async function signIn() {
  // Coming back from the Login Widget, sign in before checking the session.
  const login = takeWidgetLogin()
  const loginError = login ? await widgetLogin(login) : ''
  // Opened on a public link first, the Mini App script is not loaded yet.
  await loadHost()
  try {
    await call(client.session.$get())
    ready.value = true
  } catch {
    const data = host()?.initData
    if (!data) {
      browserLogin.value = true
      error.value = loginError
    } else {
      try {
        await call(client.auth.telegram.$post({ json: { init_data: data } }))
        ready.value = true
      } catch (e) {
        error.value = errorText(e)
      }
    }
  } finally {
    loading.value = false
  }
}
onUnmounted(() => cleanup())
</script>

<template>
  <PublicShare v-if="shared" />
  <CollectionLibrary v-else-if="ready" />
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
