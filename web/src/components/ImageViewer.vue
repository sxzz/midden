<script setup vapor lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import { assetURL, type Asset } from '../api'
import { useImageSwipe } from '../composables/useImageSwipe'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{ images: Asset[]; initialId: string }>()
const emit = defineEmits<{ close: [] }>()
const index = shallowRef(
  Math.max(
    0,
    props.images.findIndex((a) => a.id === props.initialId),
  ),
)
const selected = computed(() => props.images[index.value])
const dialog = useTemplateRef<HTMLDialogElement>('viewer')
const track = useTemplateRef<HTMLDivElement>('track')
// Every page sits on the track, but only the pages we have reached request
// their asset, so opening a long album never fetches all of it at once.
const loaded = shallowRef<string[]>([])
watch(
  index,
  (at) => {
    const near = props.images
      .slice(Math.max(0, at - 1), at + 2)
      .map((image) => image.id)
      .filter((id) => !loaded.value.includes(id))
    if (near.length) loaded.value = [...loaded.value, ...near]
  },
  { immediate: true },
)
function move(delta: number) {
  index.value = Math.max(
    0,
    Math.min(props.images.length - 1, index.value + delta),
  )
}
const { offset, dragging, moved, start, drag, end, cancel } = useImageSwipe({
  count: () => props.images.length,
  index,
  track: () => track.value,
  commit: move,
})
// Percentages resolve against the track, which is exactly one page wide.
const trackStyle = computed(() => ({
  transform: `translate3d(calc(${index.value * -100}% + ${offset.value}px), 0, 0)`,
}))
let previousOverflow = ''
let opener: HTMLElement | null = null
onMounted(() => {
  opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
watch(
  () => props.images,
  () => emit('close'),
)
function keydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    move(event.key === 'ArrowLeft' ? -1 : 1)
  }
}
// Tapping the matte beside the photo closes it; the tail of a drag must not.
function dismiss() {
  if (!moved.value) emit('close')
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
    <div
      class="stage"
      @touchstart.passive="start"
      @touchmove="drag"
      @touchend.passive="end"
      @touchcancel.passive="cancel"
    >
      <div
        ref="track"
        class="track"
        :class="{ held: dragging }"
        :style="trackStyle"
      >
        <div
          v-for="(image, slot) in images"
          :key="image.id"
          class="slide"
          :aria-hidden="slot !== index"
          @click.self="dismiss"
        >
          <LoadingImage
            v-if="loaded.includes(image.id)"
            :src="assetURL(image)"
            :alt="image.alt_text || '收藏图片'"
            loading="eager"
          />
        </div>
      </div>
    </div>

    <div class="chrome chrome-top">
      <button
        type="button"
        class="glass close"
        autofocus
        aria-label="关闭图片"
        @click="emit('close')"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
        >
          <path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4" />
        </svg>
      </button>
      <p
        v-if="images.length > 1"
        class="glass counter"
        role="status"
        aria-live="polite"
      >
        {{ index + 1 }} / {{ images.length }}
      </p>
    </div>

    <div
      v-if="selected?.alt_text || images.length > 1"
      class="chrome chrome-bottom"
    >
      <p v-if="selected?.alt_text" class="caption">{{ selected.alt_text }}</p>
      <div v-if="images.length > 1" class="glass remote">
        <button
          type="button"
          class="nav"
          :disabled="index === 0"
          aria-label="上一张"
          @click="move(-1)"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14.5 5.5 8 12l6.5 6.5" />
          </svg>
        </button>
        <span v-if="images.length <= 8" class="dots" aria-hidden="true">
          <span
            v-for="(image, slot) in images"
            :key="image.id"
            class="dot"
            :class="{ on: slot === index }"
          />
        </span>
        <button
          type="button"
          class="nav"
          :disabled="index === images.length - 1"
          aria-label="下一张"
          @click="move(1)"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9.5 5.5 16 12l-6.5 6.5" />
          </svg>
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
  color-scheme: dark;
  overscroll-behavior: contain;
  /* Retint the shared skeleton tokens so loading never flashes light grey. */
  --fill: #1c1c1e;
  --card: #2c2c2e;
  --subtle: rgba(235, 235, 245, 0.6);
}
.viewer[open] {
  display: block;
}
.viewer::backdrop {
  background: #000;
}

/* Canvas: the photo owns the whole viewport, chrome only floats above it. */
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: pan-y pinch-zoom;
}
.track {
  display: flex;
  width: 100%;
  height: 100%;
  transition: transform 420ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}
/* While a finger owns the track it must follow, not chase. */
.track.held {
  transition: none;
}
.slide {
  display: grid;
  flex: 0 0 100%;
  place-items: center;
  min-width: 0;
}
.slide :deep(.image-shell) {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  background-color: transparent;
  /* The matte belongs to the slide, so taps beside the photo reach it. */
  pointer-events: none;
}
.slide :deep(.image-shell[aria-busy='true']) {
  width: min(76vw, 440px);
  height: 42dvh;
  border-radius: 16px;
  background-color: var(--fill);
}
.slide :deep(.image-shell img) {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: auto;
  /* Keep the native long-press "save image" sheet reachable on iOS. */
  -webkit-touch-callout: default;
}

.chrome {
  position: absolute;
  right: 0;
  left: 0;
  pointer-events: none;
}
.chrome-top {
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: calc(env(safe-area-inset-top, 0px) + 12px)
    calc(env(safe-area-inset-right, 0px) + 14px) 12px
    calc(env(safe-area-inset-left, 0px) + 14px);
}
.chrome-bottom {
  bottom: 0;
  display: grid;
  justify-items: center;
  gap: 14px;
  padding: 56px calc(env(safe-area-inset-right, 0px) + 14px)
    calc(env(safe-area-inset-bottom, 0px) + 14px)
    calc(env(safe-area-inset-left, 0px) + 14px);
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.62),
    rgba(0, 0, 0, 0.22) 52%,
    transparent
  );
}

/* One glass family: a tinted pane, a specular top edge and a lifted shadow. */
.glass {
  border-radius: 999px;
  background-color: rgba(18, 18, 20, 0.58);
  background-image: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.14),
    rgba(255, 255, 255, 0.02) 48%,
    rgba(255, 255, 255, 0.08)
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.26),
    inset 0 0 0 0.5px rgba(255, 255, 255, 0.1),
    0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(26px) saturate(180%);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  pointer-events: auto;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
@supports not (
  (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))
) {
  .glass {
    background-color: rgba(18, 18, 20, 0.86);
  }
}

.close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  color: #fff;
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
.close:active {
  transform: scale(0.9);
}
.counter {
  display: flex;
  align-items: center;
  min-height: 32px;
  margin: 0;
  padding: 0 13px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  pointer-events: none;
}
.caption {
  max-width: 640px;
  max-height: 4.6em;
  margin: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: rgba(235, 235, 245, 0.78);
  font-size: 13px;
  line-height: 1.45;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}

/* Arrows and page dots read as one glass remote rather than loose buttons. */
.remote {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
}
.nav {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
.nav:active:not(:disabled) {
  transform: scale(0.88);
}
.nav:disabled {
  opacity: 0.32;
}
.icon {
  display: block;
  width: 21px;
  height: 21px;
}
.dots {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: rgba(235, 235, 245, 0.34);
  transition:
    width 320ms cubic-bezier(0.32, 0.72, 0, 1),
    background-color 320ms ease;
}
.dot.on {
  width: 17px;
  background: rgba(255, 255, 255, 0.95);
}

/* style.css already neutralises durations; restated so the intent is local. */
@media (prefers-reduced-motion: reduce) {
  .track,
  .dot,
  .nav,
  .close {
    transition: none;
  }
}
</style>
