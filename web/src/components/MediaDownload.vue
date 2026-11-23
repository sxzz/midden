<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { assetURL, errorText, telegramDownload, type Asset } from '../api'
import { host } from '../host'
const props = defineProps<{ asset: Asset }>()
const error = shallowRef('')
function download(event: MouseEvent) {
  const tg = host()
  if (!tg?.initData || !tg.downloadFile || !tg.isVersionAtLeast?.('8.0')) return
  event.preventDefault()
  error.value = ''
  try {
    tg.downloadFile(telegramDownload(props.asset))
  } catch (e) {
    error.value = errorText(e)
  }
}
</script>

<template>
  <a :href="assetURL(asset, false)" @click="download"><slot /></a>
  <span v-if="error" role="alert">{{ error }}</span>
</template>
