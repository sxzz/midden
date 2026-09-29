import { computed, onUnmounted, shallowRef, watch } from 'vue'
import {
  api,
  errorText,
  type Collection,
  type Job,
  type Page,
  type Revision,
} from '../api'
export function useCollectionDetail(
  id: () => string,
  deleted: (id: string) => void,
  updated: (collection: Collection) => void,
) {
  const available = shallowRef(false)
  const collection = shallowRef<Collection>()
  const error = shallowRef('')
  const busy = shallowRef(false)
  const status = shallowRef('')
  const revisions = shallowRef<Revision[]>([])
  const next = shallowRef('')
  const showHistory = shallowRef(false)
  const latestRevision = shallowRef('')
  const loadingRevision = shallowRef(false)
  const historyLoading = shallowRef(false)
  const historyLoaded = shallowRef(false)
  const confirmDelete = shallowRef(false)
  const historical = computed(
    () =>
      !!collection.value &&
      collection.value.revision_id !== latestRevision.value,
  )
  const noHistory = computed(
    () => historyLoaded.value && !next.value && revisions.value.length <= 1,
  )
  let controller = new AbortController()
  async function checkAvailability() {
    try {
      available.value = (
        await api<{ available: boolean }>(`/collections/${id()}/availability`, {
          signal: controller.signal,
        })
      ).available
    } catch (e) {
      if (!controller.signal.aborted) {
        available.value = false
        error.value = errorText(e)
      }
    }
  }
  let revisionRequest = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    id,
    async (id) => {
      controller.abort()
      controller = new AbortController()
      clearTimeout(timer)
      const signal = controller.signal
      ++revisionRequest
      collection.value = undefined
      revisions.value = []
      showHistory.value = false
      latestRevision.value = ''
      loadingRevision.value = false
      historyLoading.value = false
      historyLoaded.value = false
      next.value = ''
      status.value = ''
      error.value = ''
      busy.value = false
      available.value = false
      confirmDelete.value = false
      try {
        const result = await api<Collection>(`/collections/${id}`, { signal })
        if (signal.aborted) return
        collection.value = result
        latestRevision.value = collection.value.revision_id
        void historyPage()
        available.value = (
          await api<{ available: boolean }>(`/collections/${id}/availability`, {
            signal: controller.signal,
          })
        ).available
      } catch (e) {
        if (!signal.aborted) error.value = errorText(e)
      }
    },
    { immediate: true },
  )
  onUnmounted(() => {
    controller.abort()
    clearTimeout(timer)
  })
  async function historyPage(more = false) {
    if (historyLoading.value || (more && !next.value)) return
    const signal = controller.signal
    historyLoading.value = true
    try {
      const p = await api<Page<Revision>>(
        `/collections/${id()}/revisions${more ? `?cursor=${encodeURIComponent(next.value)}` : ''}`,
        { signal },
      )
      if (signal.aborted) return
      revisions.value = more ? [...revisions.value, ...p.items] : p.items
      next.value = p.next_cursor || ''
      historyLoaded.value = true
    } catch (e) {
      if (!signal.aborted) error.value = errorText(e)
    } finally {
      if (!signal.aborted) historyLoading.value = false
    }
  }
  function toggleHistory() {
    showHistory.value = !showHistory.value
    if (showHistory.value && !historyLoaded.value) void historyPage()
  }
  async function revision(revisionID?: string) {
    if (
      busy.value ||
      loadingRevision.value ||
      (revisionID
        ? revisionID === collection.value?.revision_id
        : !historical.value)
    )
      return
    const request = ++revisionRequest
    const signal = controller.signal
    loadingRevision.value = true
    error.value = ''
    try {
      const result = await api<Collection>(
        `/collections/${id()}${revisionID && revisionID !== latestRevision.value ? `/revisions/${revisionID}` : ''}`,
        { signal },
      )
      if (signal.aborted || request !== revisionRequest) return
      collection.value = result
      if (!revisionID || revisionID === latestRevision.value)
        latestRevision.value = result.revision_id
    } catch (e) {
      if (!signal.aborted && request === revisionRequest)
        error.value = errorText(e)
    } finally {
      if (!signal.aborted && request === revisionRequest)
        loadingRevision.value = false
    }
  }
  async function remove() {
    busy.value = true
    try {
      await api(`/collections/${id()}`, {
        method: 'DELETE',
        signal: controller.signal,
      })
      deleted(id())
    } catch (e) {
      error.value = errorText(e)
    } finally {
      busy.value = false
    }
  }
  async function poll(job: Job) {
    if (controller.signal.aborted) return
    status.value =
      job.state === 'queued'
        ? '正在采集…'
        : job.state === 'downloading'
          ? '正在保存媒体…'
          : job.state === 'partial'
            ? '已更新，部分媒体缺失。'
            : job.state === 'failed'
              ? '重新抓取失败，旧版本仍可查看。'
              : '已更新。'
    if (['queued', 'downloading'].includes(job.state)) {
      timer = setTimeout(async () => {
        try {
          await poll(
            await api<Job>(`/jobs/${job.id}`, { signal: controller.signal }),
          )
        } catch (e) {
          busy.value = false
          error.value = errorText(e)
        }
      }, 2000)
    } else {
      busy.value = false
      if (job.state !== 'failed') {
        collection.value = await api<Collection>(
          `/collections/${job.collection_id}`,
          {
            signal: controller.signal,
          },
        )
        if (job.collection_id !== id())
          location.hash = `/collection/${job.collection_id}`
        latestRevision.value = collection.value.revision_id
        await historyPage()
        updated(collection.value)
      }
    }
  }
  async function refresh() {
    ++revisionRequest
    busy.value = true
    error.value = ''
    try {
      await poll(
        await api<Job>('/captures', {
          method: 'POST',
          body: JSON.stringify({ refresh_id: id() }),
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          signal: controller.signal,
        }),
      )
    } catch (e) {
      error.value = errorText(e)
      busy.value = false
    }
  }
  return {
    collection,
    error,
    busy,
    status,
    revisions,
    next,
    showHistory,
    historical,
    latestRevision,
    noHistory,
    historyLoading,
    loadingRevision,
    toggleHistory,
    confirmDelete,
    available,
    historyPage,
    revision,
    remove,
    refresh,
    checkAvailability,
  }
}
