import {
  computed,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'
import type { Asset } from '../api'

/**
 * Reveal state for one media group.
 *
 * A single sensitive resource among others is uncovered on its own, by tapping
 * it. When every resource in the group is sensitive there is nothing to look at
 * behind the veils, so the group takes one veil and one tap instead of asking
 * for the same decision once per tile. Either way the first tap only uncovers;
 * opening the viewer takes a second, deliberate tap.
 */
export function useSensitiveMedia(
  assets: MaybeRefOrGetter<Asset[]>,
  showSensitive: MaybeRefOrGetter<boolean | undefined>,
) {
  const revealed = shallowRef<string[]>([])
  const groupRevealed = shallowRef(false)
  const hidden = (asset: Asset) =>
    !!asset.sensitive &&
    !toValue(showSensitive) &&
    !revealed.value.includes(asset.id)
  /** The whole group is behind one veil, and nothing under it may be reached. */
  const covered = computed(() => {
    const list = toValue(assets)
    return (
      list.length > 0 &&
      !toValue(showSensitive) &&
      !groupRevealed.value &&
      list.every((asset) => asset.sensitive)
    )
  })
  function reveal(id: string) {
    if (!revealed.value.includes(id)) revealed.value = [...revealed.value, id]
  }
  function revealAll() {
    revealed.value = toValue(assets).map((asset) => asset.id)
    groupRevealed.value = true
  }
  function reset() {
    revealed.value = []
    groupRevealed.value = false
  }
  // A new collection, or hiding sensitive media again, takes back every reveal.
  watch(() => [toValue(assets), toValue(showSensitive)], reset)
  return { covered, hidden, reveal, revealAll, reset }
}
