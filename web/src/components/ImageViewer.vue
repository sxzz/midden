<script setup vapor lang="ts">
import {
  computed,
  onMounted,
  onBeforeUnmount,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import { assetURL, type Asset } from "../api";
import LoadingImage from "./ui/LoadingImage.vue";
const props = defineProps<{ images: Asset[]; initialId: string }>();
const emit = defineEmits<{ close: [] }>();
const index = shallowRef(
  Math.max(
    0,
    props.images.findIndex((a) => a.id === props.initialId),
  ),
);
const selected = computed(() => props.images[index.value]);
const dialog = useTemplateRef<HTMLDialogElement>("viewer");
let previousOverflow = "";
let opener: HTMLElement | null = null;
let start: { x: number; y: number } | undefined;
onMounted(() => {
  opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
watch(
  () => props.images,
  () => emit("close"),
);
function move(delta: number) {
  index.value = Math.max(
    0,
    Math.min(props.images.length - 1, index.value + delta),
  );
}
function touchStart(event: TouchEvent) {
  const touch = event.touches[0];
  start =
    event.touches.length === 1 && touch
      ? { x: touch.clientX, y: touch.clientY }
      : undefined;
}
function touchEnd(event: TouchEvent) {
  const touch = event.changedTouches[0];
  if (start && touch) {
    const dx = touch.clientX - start.x,
      dy = touch.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5)
      move(dx < 0 ? 1 : -1);
  }
  start = undefined;
}
function keydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    move(event.key === "ArrowLeft" ? -1 : 1);
  }
}
</script>
<template>
  <dialog
    ref="viewer"
    class="viewer"
    aria-label="图片预览"
    @cancel.prevent="emit('close')"
    @close="emit('close')"
    @keydown="keydown"
  >
    <div class="viewer-bar">
      <span role="status" aria-live="polite"
        >{{ index + 1 }} / {{ images.length }}</span
      ><button type="button" autofocus @click="emit('close')">关闭图片</button>
    </div>
    <div
      class="stage"
      @click.self="emit('close')"
      @touchstart.passive="touchStart"
      @touchend.passive="touchEnd"
      @touchcancel="start = undefined"
    >
      <LoadingImage
        v-if="selected"
        :key="selected.id"
        :src="assetURL(selected)"
        :alt="selected.alt_text || '收藏图片'"
        loading="eager"
      />
    </div>
    <div class="viewer-footer">
      <p v-if="selected?.alt_text" class="alt">{{ selected.alt_text }}</p>
      <div v-if="images.length > 1" class="navigation">
        <button type="button" :disabled="index === 0" @click="move(-1)">
          上一张</button
        ><span>左右滑动切换</span
        ><button
          type="button"
          :disabled="index === images.length - 1"
          @click="move(1)"
        >
          下一张
        </button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  width: 100vw;
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  margin: 0;
  padding: 0;
  border: 0;
  background: #000;
  color: #fff;
  overscroll-behavior: contain;
}
.viewer[open] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}
.viewer::backdrop {
  background: #000;
}
.viewer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: max(8px, env(safe-area-inset-top)) 16px 8px;
}
.viewer button {
  min-width: 64px;
  min-height: 44px;
  color: #fff;
  text-align: center;
}
.stage {
  display: grid;
  place-items: center;
  min-height: 0;
  touch-action: pan-y pinch-zoom;
  overflow: hidden;
}
.stage :deep(.image-shell) {
  max-width: 100%;
  max-height: 100%;
  background-color: #171717;
  object-fit: contain;
}
.stage :deep(.image-shell[aria-busy="true"]) {
  width: 100%;
  height: 60dvh;
}
.stage :deep(img) {
  width: auto;
  height: auto;
  max-height: calc(100dvh - 200px);
  margin: auto;
  object-fit: contain;
}
.viewer-footer {
  padding: 8px 16px max(12px, env(safe-area-inset-bottom));
}
.alt {
  margin: 0 0 8px;
  max-height: 70px;
  overflow: auto;
  font-size: 13px;
  color: #d5d5d5;
}
.navigation {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.navigation span {
  font-size: 13px;
  color: #aaa;
}
</style>
