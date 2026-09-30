<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { api, assetURL, errorText, type Asset } from '../api'
import { host } from '../host'
const props = defineProps<{ asset: Asset }>()
const busy = shallowRef(false)
const error = shallowRef('')
async function download(event: MouseEvent) {
  const tg = host()
  if (!tg?.initData || !tg.downloadFile || !tg.isVersionAtLeast?.('8.0')) return
  event.preventDefault()
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const params = await api<{ url: string; file_name: string }>(
      `/assets/${encodeURIComponent(props.asset.id)}/download`,
      { method: 'POST' },
    )
    tg.downloadFile(params)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <a :href="assetURL(asset, false)" :aria-busy="busy" @click="download"
    ><slot
  /></a>
  <span v-if="error" role="alert">{{ error }}</span>
</template>
