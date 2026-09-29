import { shallowRef, onUnmounted } from "vue";
import { api, errorText, type Archive, type Page } from "../api";
export function useCollection() {
  const items = shallowRef<Archive[]>([]),
    next = shallowRef(""),
    loading = shallowRef(false),
    error = shallowRef("");
  let query = "",
    controller: AbortController | undefined;
  let generation = 0;
  async function load(params: string, append = false) {
    controller?.abort();
    controller = new AbortController();
    const version = ++generation;
    loading.value = true;
    error.value = "";
    if (!append) {
      items.value = [];
      next.value = "";
    }
    query = params;
    const q = new URLSearchParams(params);
    q.set("q", q.get("q") || "");
    if (append && next.value) q.set("cursor", next.value);
    try {
      const p = await api<Page<Archive>>("/archives?" + q, {
        signal: controller.signal,
      });
      if (version !== generation) return;
      items.value = append ? [...items.value, ...p.items] : p.items;
      next.value = p.next_cursor || "";
    } catch (e) {
      if (
        version === generation &&
        !(e instanceof DOMException && e.name === "AbortError")
      )
        error.value = errorText(e);
    } finally {
      if (version === generation) loading.value = false;
    }
  }
  onUnmounted(() => controller?.abort());
  return {
    items,
    next,
    loading,
    error,
    load,
    more: () => load(query, true),
    remove: (id: string) => {
      items.value = items.value.filter((a) => a.id !== id);
    },
  };
}
