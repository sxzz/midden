import { onActivated, onDeactivated, onUnmounted, shallowRef, watch } from 'vue'
import { call, client, type VideoRemoval } from '../api'
import { mediaRemovals } from '../media-removals'
import { toast } from './useToast'

/** How often a running removal is looked at again. */
const POLL_MS = 1000
const removals = client.collections[':id']['video-removal']

const runs = (removal?: VideoRemoval) =>
  removal?.state === 'queued' || removal?.state === 'running'

/**
 * 删除所有视频 of the profile `id` (none on a post or behind a share): the
 * removal running, found when the page opens and followed until its job
 * ends. Then the pages listing the media load again, as after any removal.
 */
export function useVideoRemoval(id: () => string | undefined) {
  /** The removal running, until it ends. */
  const running = shallowRef<VideoRemoval>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = true
  // Answers to an older look (another profile) are dropped.
  let version = 0
  function follow(found: VideoRemoval | undefined) {
    const was = running.value
    if (runs(found)) {
      running.value = found
      if (active) timer = setTimeout(check, POLL_MS)
      return
    }
    running.value = undefined
    if (!was || !found || found.id !== was.id) return
    toast(
      found.state === 'complete'
        ? `已删除${found.removed}个视频`
        : `删除视频失败：${found.error ?? ''}`,
    )
    mediaRemovals.value++
  }
  async function check() {
    clearTimeout(timer)
    const profile = id()
    if (!profile) return
    const current = version
    try {
      const found = await call(removals.$get({ param: { id: profile } }))
      if (current === version) follow(found.removal)
    } catch {
      // Looked at again while one runs; nothing else depends on it.
      if (current === version && running.value && active)
        timer = setTimeout(check, POLL_MS)
    }
  }
  /** A removal the sheet just started. */
  function started(removal: VideoRemoval) {
    version++
    clearTimeout(timer)
    follow(removal)
  }
  watch(
    id,
    () => {
      version++
      clearTimeout(timer)
      running.value = undefined
      void check()
    },
    { immediate: true },
  )
  onActivated(() => {
    active = true
    if (running.value) void check()
  })
  onDeactivated(() => {
    active = false
    clearTimeout(timer)
  })
  onUnmounted(() => {
    version++
    clearTimeout(timer)
  })
  return { running, started }
}
