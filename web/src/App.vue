<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call, client, errorText } from './api'
import CollectionLibrary from './components/CollectionLibrary.vue'
import PasskeyLogin from './components/PasskeyLogin.vue'
import PasskeySetup from './components/PasskeySetup.vue'
import PublicShare from './components/PublicShare.vue'
import AppToast from './components/ui/AppToast.vue'
import CollectionSkeleton from './components/ui/CollectionSkeleton.vue'
import { host, loadHost, setupHost } from './host'
import { followInternalLink, goBack } from './navigation'
const router = useRouter()
const route = useRoute()
// A public link is read without logging in; the library asks for it only
// once one of its own pages is shown.
const shared = computed(() => !!route.meta.public)
// A /passkey link adds a passkey first, which also signs in.
const setup = computed(() => !!route.meta.setup)
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
  document.addEventListener('auxclick', follow)
  cleanup = () => {
    stopHost()
    document.removeEventListener('click', follow)
    document.removeEventListener('auxclick', follow)
  }
  let started = false
  watch(
    () => shared.value || setup.value,
    (value) => {
      if (value || started) return
      started = true
      void signIn()
    },
    { immediate: true },
  )
})
async function signIn() {
  // Opened on a public link first, the Mini App script is not loaded yet.
  await loadHost()
  try {
    await call(client.session.$get())
    ready.value = true
  } catch {
    const data = host()?.initData
    if (!data) browserLogin.value = true
    else {
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
function signedIn() {
  browserLogin.value = false
  ready.value = true
}
// The link is used up: leave its address, and the library takes over.
function passkeyAdded() {
  void router.replace('/')
}
onUnmounted(() => cleanup())
</script>

<template>
  <PublicShare v-if="shared" />
  <main v-else-if="setup" class="gate">
    <PasskeySetup :token="String(route.params.token)" @done="passkeyAdded" />
  </main>
  <!-- From 700px the library's rail, column and sidebar sit side by side,
       centred together (CollectionLibrary, layout.ts). -->
  <div v-else-if="ready" class="shell"><CollectionLibrary /></div>
  <main v-else class="gate">
    <CollectionSkeleton v-if="loading" />
    <PasskeyLogin v-else-if="browserLogin" @done="signedIn" />
    <p v-else role="status">{{ error }}</p>
  </main>
  <AppToast />
</template>

<style scoped>
@media (min-width: 700px) {
  .shell {
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
}
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
