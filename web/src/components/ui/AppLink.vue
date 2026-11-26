<script setup vapor lang="ts">
import { computed } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { appPath } from '../../app-path'
import { navigatesHere } from '../../navigation'
/**
 * A link: to a route of the app (`to`, or an `href` under `/app/`), or
 * to another site (`href`), which opens in a new tab. A plain click on an
 * app link navigates through the router; any other click is the browser's,
 * so Cmd/Ctrl-click, the middle button and the context menu open it in a new
 * tab, as RouterLink does. `navigate` fires just before an app link
 * navigates in this page, for a sheet or viewer to close itself.
 */
const props = defineProps<{
  to?: RouteLocationRaw
  href?: string
  replace?: boolean
}>()
const emit = defineEmits<{ navigate: [] }>()
const router = useRouter()
const address = computed(() =>
  props.to === undefined ? (props.href ?? '') : router.resolve(props.to).href,
)
const external = computed(
  () =>
    props.to === undefined &&
    !!address.value &&
    !address.value.startsWith('#') &&
    appPath(address.value) === undefined,
)
function click(event: MouseEvent) {
  if (
    !address.value ||
    external.value ||
    event.defaultPrevented ||
    !navigatesHere(event)
  )
    return
  event.preventDefault()
  emit('navigate')
  const to = props.to ?? appPath(address.value)!
  void (props.replace ? router.replace(to) : router.push(to))
}
</script>

<template>
  <a
    :href="address || undefined"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
    @click="click"
    @auxclick="click"
    ><slot
  /></a>
</template>
