import { shallowRef } from 'vue'
/** The newest message; `id` changes on every call so repeats show again. */
export const toastState = shallowRef<{ id: number; text: string }>()
let timer: ReturnType<typeof setTimeout> | undefined
let next = 0
/** Show a short message at the bottom of the screen, near the controls. */
export function toast(text: string) {
  clearTimeout(timer)
  toastState.value = { id: ++next, text }
  timer = setTimeout(() => {
    toastState.value = undefined
  }, 3000)
}
