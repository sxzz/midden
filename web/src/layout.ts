import { readonly, shallowRef, type Ref } from 'vue'

/**
 * The owner's app on wider screens, as X lays out its web app: from 700px a
 * rail of icons on the left (88px) takes the bottom bar's place, beside a
 * column of 600px; from 1000px a sidebar sits on the right (290px, 16px
 * from the column; 350px and 30px from 1100px); from 1280px the rail has
 * labels and is 200px, as narrow as they allow rather than X's 275px, and
 * the column takes the difference (680px). Below 700px the phone layout
 * stays as it is.
 *
 * The widths are CSS variables in style.css (`--rail-width`,
 * `--column-width`, `--sidebar-width`, `--sidebar-gap`,
 * `--column-roomy-width`), which the components use; the breakpoints are
 * here, and written in the components' media queries, which cannot read
 * either. Keep the two in step.
 */
export const RAIL = '(min-width: 700px)'
export const SIDEBAR = '(min-width: 1000px)'
// The other two, in CSS alone: 1100px (the wider sidebar) and 1280px (the
// rail's labels and the wider column).

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
