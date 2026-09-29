<script setup vapor lang="ts">
import PhotoSwipe from 'photoswipe'
import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import { assetURL, type Asset } from '../api'
import 'photoswipe/style.css'
const props = defineProps<{ images: Asset[]; initialId: string }>()
const emit = defineEmits<{ close: [] }>()
const index = shallowRef(
  Math.max(
    0,
    props.images.findIndex((image) => image.id === props.initialId),
  ),
)
const selected = computed(() => props.images[index.value])
const dialog = useTemplateRef<HTMLDialogElement>('viewer')
const stage = useTemplateRef<HTMLDivElement>('stage')
let photoSwipe: PhotoSwipe | undefined
let previousOverflow = ''
let opener: HTMLElement | null = null
let disposed = false
let closeRequested = false
function close() {
  closeRequested = true
  photoSwipe?.close()
}
function move(delta: number) {
  photoSwipe?.mainScroll.moveIndexBy(
    delta,
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    move(event.key === 'ArrowLeft' ? -1 : 1)
  }
}
onMounted(() => {
  if (!stage.value) return
  opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
  const previews = [
    ...document.querySelectorAll<HTMLImageElement>('.media img'),
  ]
  const dataSource = props.images.map((image) => {
    const src = assetURL(image)
    const preview = previews.find(
      (img) => img.src === new URL(src, location.href).href && img.naturalWidth,
    )
    return {
      src,
      alt: image.alt_text || '收藏图片',
      width: preview?.naturalWidth || 1600,
      height: preview?.naturalHeight || 1200,
    }
  })
  const pswp = new PhotoSwipe({
    dataSource,
    index: index.value,
    appendToEl: stage.value,
    loop: false,
    preload: [1, 1],
    bgOpacity: 1,
    close: false,
    zoom: false,
    counter: false,
    arrowPrev: false,
    arrowNext: false,
    // The outer native dialog owns focus, keyboard navigation and Vue controls.
    trapFocus: false,
    returnFocus: false,
    escKey: false,
    arrowKeys: false,
    showHideAnimationType: 'fade',
    showAnimationDuration: 180,
    hideAnimationDuration: 180,
    imageClickAction: 'zoom',
    tapAction: false,
    doubleTapAction: 'zoom',
    errorMsg: '图片加载失败，请关闭后重试',
  })
  photoSwipe = pswp
  pswp.on('openingAnimationEnd', () => {
    if (disposed) pswp.destroy()
    else if (closeRequested) pswp.close()
  })
  pswp.on('change', () => {
    index.value = pswp.currIndex
  })
  pswp.on('afterInit', () => {
    pswp.element?.removeAttribute('role')
    pswp.element?.removeAttribute('aria-modal')
  })
  // The API does not expose dimensions yet. Use existing thumbnails immediately,
  // then resolve uncached slides from the library's own image load (no extra fetch).
  pswp.on('contentLoadImage', ({ content }) => {
    const image = content.element
    if (!(image instanceof HTMLImageElement)) return
    image.addEventListener(
      'load',
      () => {
        if (
          disposed ||
          !image.naturalWidth ||
          (content.width === image.naturalWidth &&
            content.height === image.naturalHeight)
        )
          return
        content.data.width = content.width = image.naturalWidth
        content.data.height = content.height = image.naturalHeight
        if (content.slide)
          queueMicrotask(() => {
            if (!disposed && pswp.isOpen)
              pswp.refreshSlideContent(content.index)
          })
      },
      { once: true },
    )
  })
  pswp.on('destroy', () => {
    if (!disposed) emit('close')
  })
  pswp.init()
})
onBeforeUnmount(() => {
  disposed = true
  photoSwipe?.destroy()
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
watch(
  () => props.images,
  () => emit('close'),
)
</script>

<template>
  <dialog
    ref="viewer"
    class="viewer"
    aria-label="图片预览"
    @cancel.prevent="close"
    @close="emit('close')"
    @keydown="keydown"
  >
    <div ref="stage" class="stage" />

    <div class="chrome chrome-top">
      <button
        type="button"
        class="glass close"
        autofocus
        aria-label="关闭图片"
        @click="close"
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
.stage :deep(.pswp) {
  position: absolute;
  z-index: 0;
}
.stage :deep(.pswp__img) {
  max-width: none;
  -webkit-touch-callout: default;
}
.stage :deep(.pswp__img--placeholder) {
  background: linear-gradient(100deg, #1c1c1e 25%, #2c2c2e 45%, #1c1c1e 65%);
  background-size: 240% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
}
.stage :deep(.pswp__preloader) {
  display: none;
}
.stage :deep(.pswp__error-msg) {
  color: var(--subtle);
  font-size: 14px;
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
  .dot,
  .nav,
  .close {
    transition: none;
  }
}
</style>
