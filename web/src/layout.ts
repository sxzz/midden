import { readonly, shallowRef, type Ref } from 'vue'

/**
 * The owner's app on wider screens, as X lays out its web app: from 700px a
 * rail of icons on the left takes the bottom bar's place, beside a column
 * of about 600px; from 1280px the rail has labels and a sidebar sits on the
 * right. Below 700px the phone layout stays as it is. The same widths are
 * written in the components' CSS; keep them in step.
 */
export const RAIL = '(min-width: 700px)'
export const FULL = '(min-width: 1280px)'

const queries = new Map<string, Readonly<Ref<boolean>>>()

/** Whether the window matches `query`, following it as it changes. */
export function useMedia(query: string): Readonly<Ref<boolean>> {
  let shared = queries.get(query)
  if (!shared) {
    const list = globalThis.matchMedia?.(query)
    const matches = shallowRef(!!list?.matches)
    list?.addEventListener?.('change', () => (matches.value = list.matches))
    shared = readonly(matches)
    queries.set(query, shared)
  }
  return shared
}
