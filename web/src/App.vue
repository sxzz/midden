<script setup vapor lang="ts">
import { shallowRef, onMounted, onUnmounted } from "vue";
import { api, errorText } from "./api";
import { host, setupHost } from "./host";
import CollectionLibrary from "./components/CollectionLibrary.vue";
const ready = shallowRef(false),
  error = shallowRef(""),
  loading = shallowRef(true);
let cleanup = () => {};
onMounted(async () => {
  cleanup = setupHost();
  try {
    await api("/session");
    ready.value = true;
  } catch {
    const data = host()?.initData;
    if (!data) {
      error.value = "请从 Telegram Bot 的「打开收藏库」进入。";
    } else {
      try {
        await api("/auth/telegram", {
          method: "POST",
          body: JSON.stringify({ init_data: data }),
        });
        ready.value = true;
      } catch (e) {
        error.value = errorText(e);
      }
    }
  } finally {
    loading.value = false;
  }
});
onUnmounted(() => cleanup());
</script>
<template>
  <CollectionLibrary v-if="ready" />
  <main v-else class="gate">
    <p role="status">{{ loading ? "正在打开收藏…" : error }}</p>
  </main>
</template>
<style scoped>
.gate {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: 32px;
}
.gate p {
  margin: 0;
  max-width: 320px;
  text-align: center;
  font-size: 15px;
  line-height: 1.7;
  color: var(--subtle);
}
</style>
