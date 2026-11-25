<script setup vapor lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { goBack, homeRoute, navigatesHere } from '../../navigation'
// 返回: back through history, or to the tab's start when the page was
// opened directly. It is a link to that start, so a new tab opens there.
const router = useRouter()
const href = computed(
  () => router.resolve(homeRoute(router.currentRoute?.value.name)).href,
)
function click(event: MouseEvent) {
  if (!navigatesHere(event)) return
  event.preventDefault()
  goBack(router)
}
</script>

<template>
  <a :href="href" @click="click" @auxclick="click"><slot /></a>
</template>
