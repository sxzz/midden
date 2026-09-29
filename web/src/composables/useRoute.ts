import { onUnmounted, shallowRef } from 'vue'
export function useRoute() {
  const route = shallowRef(location.hash.slice(1) || '/')
  const update = () => (route.value = location.hash.slice(1) || '/')
  addEventListener('hashchange', update)
  onUnmounted(() => removeEventListener('hashchange', update))
  return route
}
export function navigate(route: string) {
  location.hash = route
}
