import { shallowRef, watch, onUnmounted } from "vue";
import {
  api,
  errorText,
  type Collection,
  type Revision,
  type Page,
  type Job,
} from "../api";
export function useCollectionDetail(
  id: () => string,
  deleted: (id: string) => void,
  updated: (collection: Collection) => void,
) {
  const available = shallowRef(false);
  const collection = shallowRef<Collection>(),
    error = shallowRef(""),
    busy = shallowRef(false),
    status = shallowRef(""),
    revisions = shallowRef<Revision[]>([]),
    next = shallowRef(""),
    showHistory = shallowRef(false),
    historical = shallowRef(false),
    confirmDelete = shallowRef(false);
  let controller = new AbortController();
  async function checkAvailability() {
    try {
      available.value = (
        await api<{ available: boolean }>(
          "/collections/" + id() + "/availability",
          { signal: controller.signal },
        )
      ).available;
    } catch (e) {
      if (!controller.signal.aborted) {
        available.value = false;
        error.value = errorText(e);
      }
    }
  }
  let revisionRequest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    id,
    async (id) => {
      controller.abort();
      controller = new AbortController();
      clearTimeout(timer);
      collection.value = undefined;
      revisions.value = [];
      showHistory.value = false;
      historical.value = false;
      error.value = "";
      busy.value = false;
      try {
        collection.value = await api<Collection>("/collections/" + id, {
          signal: controller.signal,
        });
        available.value = (
          await api<{ available: boolean }>(
            "/collections/" + id + "/availability",
            {
              signal: controller.signal,
            },
          )
        ).available;
      } catch (e) {
        if (!controller.signal.aborted) error.value = errorText(e);
      }
    },
    { immediate: true },
  );
  onUnmounted(() => {
    controller.abort();
    clearTimeout(timer);
  });
  async function historyPage(more = false) {
    try {
      const p = await api<Page<Revision>>(
        `/collections/${id()}/revisions${more ? "?cursor=" + encodeURIComponent(next.value) : ""}`,
        { signal: controller.signal },
      );
      revisions.value = more ? [...revisions.value, ...p.items] : p.items;
      next.value = p.next_cursor || "";
      showHistory.value = true;
    } catch (e) {
      error.value = errorText(e);
    }
  }
  async function revision(revisionID?: string) {
    const request = ++revisionRequest;
    try {
      const result = await api<Collection>(
        `/collections/${id()}${revisionID ? "/revisions/" + revisionID : ""}`,
        { signal: controller.signal },
      );
      if (request !== revisionRequest) return;
      collection.value = result;
      historical.value = !!revisionID;
    } catch (e) {
      error.value = errorText(e);
    }
  }
  async function remove() {
    busy.value = true;
    try {
      await api("/collections/" + id(), {
        method: "DELETE",
        signal: controller.signal,
      });
      deleted(id());
    } catch (e) {
      error.value = errorText(e);
    } finally {
      busy.value = false;
    }
  }
  async function poll(job: Job) {
    if (controller.signal.aborted) return;
    status.value =
      job.state === "queued"
        ? "正在采集…"
        : job.state === "downloading"
          ? "正在保存媒体…"
          : job.state === "partial"
            ? "已更新，部分媒体缺失。"
            : job.state === "failed"
              ? "重新抓取失败，旧版本仍可查看。"
              : "已更新。";
    if (["queued", "downloading"].includes(job.state)) {
      timer = setTimeout(async () => {
        try {
          await poll(
            await api<Job>("/jobs/" + job.id, { signal: controller.signal }),
          );
        } catch (e) {
          busy.value = false;
          error.value = errorText(e);
        }
      }, 2000);
    } else {
      busy.value = false;
      if (job.state !== "failed") {
        collection.value = await api<Collection>(
          "/collections/" + job.collection_id,
          {
            signal: controller.signal,
          },
        );
        if (job.collection_id !== id())
          location.hash = "/collection/" + job.collection_id;
        historical.value = false;
        updated(collection.value);
      }
    }
  }
  async function refresh() {
    ++revisionRequest;
    busy.value = true;
    error.value = "";
    try {
      await poll(
        await api<Job>("/captures", {
          method: "POST",
          body: JSON.stringify({ refresh_id: id() }),
          headers: { "Idempotency-Key": crypto.randomUUID() },
          signal: controller.signal,
        }),
      );
    } catch (e) {
      error.value = errorText(e);
      busy.value = false;
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
    confirmDelete,
    available,
    historyPage,
    revision,
    remove,
    refresh,
    checkAvailability,
  };
}
