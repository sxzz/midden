import {
  computed,
  onActivated,
  onDeactivated,
  onUnmounted,
  shallowRef,
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import {
  api,
  errorText,
  type Collection,
  type Job,
  type MemberProgress,
  type Page,
  type Revision,
  type UpdateMode,
} from '../api'
import { toast } from './useToast'
const settled = (m?: MemberProgress) =>
  m ? m.complete + m.partial + m.failed : 0
function memberStatus(m: MemberProgress) {
  if (!m.done)
    return `已更新，正在保存帖子${m.pending ? `（剩余 ${m.pending} 条）` : ''}…`
  if (!m.total) return '已更新。'
  return [
    `已更新，${m.complete} 条帖子已保存`,
    m.partial && `${m.partial} 条不完整`,
    m.failed && `${m.failed} 条失败`,
  ]
    .filter(Boolean)
    .join('，')
    .concat('。')
}
export function useCollectionDetail(
  id: () => string,
  deleted: (id: string) => void,
  updated: (collection: Collection) => void,
) {
  const router = useRouter()
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
  /**
   * Bumped whenever a refresh brings in new member content (such as a
   * profile's posts), so lists of those members know to reload.
   */
  const membersVersion = shallowRef(0)
  const historical = computed(
    () =>
      !!collection.value &&
      collection.value.revision_id !== latestRevision.value,
  )
  const noHistory = computed(
    () => historyLoaded.value && !next.value && revisions.value.length <= 1,
  )
  let controller = new AbortController()
  // Once the collection is on screen, a failed action must not replace it or
  // land in a banner out of view: say so where the reader is looking.
  function report(e: unknown) {
    const text = errorText(e)
    if (collection.value) toast(text)
    else error.value = text
  }
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
        report(e)
      }
    }
  }
  let revisionRequest = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // While this detail sits in the navigation cache it keeps its state but must
  // stay quiet: no polling requests and no routing from a view nobody sees.
  let visible = true
  let pending: Job | undefined
  // A finished collection capture whose members are still being captured.
  let members: Job | undefined
  // Only the newest poll chain may act. Deactivating, switching collection or
  // starting a capture retires the previous chain, so a reply still in flight
  // cannot schedule a second timer or write its result after the fact.
  let pollRun = 0
  const stale = (run: number) => controller.signal.aborted || run !== pollRun
  function retirePoll() {
    ++pollRun
    clearTimeout(timer)
  }
  function failed(e: unknown) {
    if (controller.signal.aborted) return
    busy.value = false
    report(e)
  }
  onDeactivated(() => {
    visible = false
    retirePoll()
  })
  onActivated(() => {
    visible = true
    // Resuming can reject on its own request, which must surface as an error
    // rather than an unhandled rejection from the lifecycle hook.
    if (pending) startPoll(pending).catch(failed)
    else if (members) {
      retirePoll()
      watchMembers(members, pollRun)
    }
  })
  watch(
    id,
    async (id) => {
      controller.abort()
      controller = new AbortController()
      retirePoll()
      pending = undefined
      members = undefined
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
    retirePoll()
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
      if (!signal.aborted) report(e)
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
      if (!signal.aborted && request === revisionRequest) report(e)
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
      report(e)
    } finally {
      busy.value = false
    }
  }
  /** Start a fresh poll chain, retiring whatever chain was running before. */
  function startPoll(job: Job) {
    retirePoll()
    members = undefined
    return poll(job, pollRun)
  }
  async function poll(job: Job, run: number) {
    if (stale(run)) return
    pending = job
    status.value =
      job.state === 'queued'
        ? '正在采集…'
        : job.state === 'downloading'
          ? '正在保存媒体…'
          : job.state === 'partial'
            ? '已更新，部分媒体缺失。'
            : job.state === 'failed'
              ? '重新抓取失败。'
              : '已更新。'
    if (['queued', 'downloading'].includes(job.state)) {
      if (!visible) return
      timer = setTimeout(async () => {
        try {
          const next = await api<Job>(`/jobs/${job.id}`, {
            signal: controller.signal,
          })
          await poll(next, run)
        } catch (e) {
          if (stale(run)) return
          failed(e)
        }
      }, 2000)
      return
    }
    // Finish the job only while shown, so the pending state survives a trip
    // through the cache and resumes on the next activation.
    if (!visible) return
    busy.value = false
    if (job.state !== 'failed') {
      const result = await api<Collection>(
        `/collections/${job.collection_id}`,
        { signal: controller.signal },
      )
      if (stale(run) || !visible) return
      collection.value = result
      if (job.collection_id !== id())
        void router.replace({
          name: 'collection',
          params: { id: job.collection_id },
        })
      latestRevision.value = result.revision_id
      await historyPage()
      // Landing here after the view was cached would push this job's result
      // into a list the user has already navigated away from.
      if (stale(run) || !visible) return
      updated(result)
      membersVersion.value++
    }
    pending = undefined
    if (job.state !== 'failed' && job.members && !job.members.done)
      watchMembers(job, run)
  }
  /**
   * The collection's own capture only lists its members; their captures finish
   * later. Keep following them and reload member lists as content lands,
   * throttled so a large batch does not reload on every poll.
   */
  function watchMembers(
    job: Job,
    run: number,
    last?: { at: number; settled: number },
  ) {
    let reloaded = last ?? { at: Date.now(), settled: settled(job.members) }
    if (stale(run) || !job.members) return
    status.value = memberStatus(job.members)
    if (job.members.done) {
      members = undefined
      return
    }
    members = job
    if (!visible) return
    timer = setTimeout(async () => {
      try {
        const next = await api<Job>(`/jobs/${job.id}`, {
          signal: controller.signal,
        })
        if (stale(run)) return
        const landed = settled(next.members) !== reloaded.settled
        if (
          next.members?.done ||
          (landed && Date.now() - reloaded.at >= 6000)
        ) {
          membersVersion.value++
          reloaded = { at: Date.now(), settled: settled(next.members) }
        }
        watchMembers(next, run, reloaded)
      } catch (e) {
        if (stale(run)) return
        failed(e)
      }
    }, 2000)
  }
  async function refresh(mode: UpdateMode) {
    if (busy.value) return
    ++revisionRequest
    busy.value = true
    try {
      await startPoll(
        await api<Job>('/captures', {
          method: 'POST',
          body: JSON.stringify({ refresh_id: id(), update_mode: mode }),
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          signal: controller.signal,
        }),
      )
    } catch (e) {
      report(e)
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
    membersVersion,
  }
}
