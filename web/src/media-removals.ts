import { shallowRef } from 'vue'
/**
 * How many times media was removed from the viewer. Pages that list the
 * media watch it and load again, as the viewer opens from all of them.
 */
export const mediaRemovals = shallowRef(0)
