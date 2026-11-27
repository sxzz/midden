import { shallowRef } from 'vue'
import type { Collection, RemovalEffect } from './api'
/**
 * How many times media was removed in bulk. Pages that list the media watch
 * it and load again, as the sizes and the order may have changed.
 */
export const mediaRemovals = shallowRef(0)
/**
 * The one media item the viewer removed last. Pages that hold it show it as
 * removed in place, so nothing is loaded again and nothing moves.
 */
export const mediaRemoved = shallowRef<{
  collection: string
  asset: string
  effect: RemovalEffect
}>()
/** The collection with one of its media shown as removed, and its size less. */
export function withRemovedMedia(
  collection: Collection,
  asset: string,
  effect: RemovalEffect,
): Collection {
  return {
    ...collection,
    assets: collection.assets?.map((item) =>
      item.id === asset
        ? {
            ...item,
            state: 'removed',
            size: 0,
            url: undefined,
            download_url: undefined,
          }
        : item,
    ),
    ...(collection.storage_bytes === undefined
      ? {}
      : {
          storage_bytes: Math.max(
            0,
            collection.storage_bytes - effect.freed_bytes,
          ),
        }),
  }
}
