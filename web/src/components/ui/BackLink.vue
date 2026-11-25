<script setup vapor lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { backRoute, goBack, navigatesHere } from '../../navigation'
// 返回: to the page before this one in its tab, or to the tab's start when
// the page was opened directly. It is a link there, so a new tab opens on
// the same page.
const router = useRouter()
const href = computed(() => router.resolve(backRoute(router)).href)
function click(event: MouseEvent) {
  if (!navigatesHere(event)) return
  event.preventDefault()
  goBack(router)
}
</script>

<template>
  <a :href="href" @click="click" @auxclick="click"><slot /></a>
</template>
