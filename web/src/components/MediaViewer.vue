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
import { api, assetURL, errorText, type Asset } from '../api'
import { host } from '../host'
import ViewerDetailButton from './ui/ViewerDetailButton.vue'
import 'photoswipe/style.css'
const props = defineProps<{
  assets: Asset[]
  initialId: string
  collectionId?: string
  collectionIds?: Record<string, string>
}>()
const emit = defineEmits<{ close: []; open: [id: string] }>()
const index = shallowRef(
  Math.max(
    0,
    props.assets.findIndex((image) => image.id === props.initialId),
  ),
)
const selected = computed(() => props.assets[index.value])
const selectedCollection = computed(
  () =>
    selected.value &&
    (props.collectionIds?.[selected.value.id] || props.collectionId),
)
const isVideo = computed(() => selected.value?.mime?.startsWith('video/'))
const videos = new Set<HTMLVideoElement>()
const dialog = useTemplateRef<HTMLDialogElement>('viewer')
const stage = useTemplateRef<HTMLDivElement>('stage')
const saving = shallowRef(false)
const saveError = shallowRef('')
async function save() {
  const image = selected.value
  if (!image || saving.value) return
  saveError.value = ''
  const tg = host()
  if (tg?.initData && tg.downloadFile && tg.isVersionAtLeast?.('8.0')) {
    saving.value = true
    try {
      const params = await api<{ url: string; file_name: string }>(
        `/assets/${encodeURIComponent(image.id)}/download`,
        { method: 'POST' },
      )
      if (!disposed) tg.downloadFile(params)
    } catch (error) {
      saveError.value = errorText(error)
    } finally {
      saving.value = false
    }
  } else {
    const link = document.createElement('a')
    link.href = assetURL(image, false)
    link.download = image.id
    link.target = '_blank'
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
  }
}
let photoSwipe: PhotoSwipe | undefined
let previousOverflow = ''
let opener: HTMLElement | null = null
let disposed = false
function close() {
  if (!photoSwipe?.opener.isOpen) emit('close')
  else photoSwipe.close()
}
function move(delta: number) {
  photoSwipe?.mainScroll.moveIndexBy(
    delta,
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}
function keydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLVideoElement) return
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
    ...document.querySelectorAll<HTMLImageElement>(
      '.media img, .thumbs img, .album img, .author img',
    ),
  ]
  const dataSource = props.assets.map((image) => {
    const src = assetURL(image)
    if (image.mime?.startsWith('video/')) {
      const preview = [
        ...document.querySelectorAll<HTMLVideoElement>(
          '.media video, .thumbs video, .album video',
        ),
      ].find(
        (video) => video.src.split('#')[0] === new URL(src, location.href).href,
      )
      return {
        src,
        type: 'video',
        alt: image.alt_text || '收藏视频',
        width: preview?.videoWidth || 1600,
        height: preview?.videoHeight || 900,
      }
    }
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
    errorMsg: '媒体加载失败',
    paddingFn: (_viewport, item) =>
      item.type === 'video'
        ? { top: 72, bottom: 110, left: 12, right: 12 }
        : { top: 0, bottom: 0, left: 0, right: 0 },
  })
  photoSwipe = pswp
  pswp.on('contentLoad', (event) => {
    const { content } = event
    if (content.data.type !== 'video') return
    event.preventDefault()
    const container = document.createElement('div')
    container.className = 'video-slide'
    const video = document.createElement('video')
    video.src = content.data.src || ''
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    video.setAttribute('aria-label', content.data.alt || '收藏视频')
    video.addEventListener(
      'error',
      () => {
        if (disposed) return
        const error = document.createElement('p')
        error.setAttribute('role', 'alert')
        error.textContent = '视频无法播放，可保存后观看'
        container.replaceChildren(error)
      },
      { once: true },
    )
    videos.add(video)
    container.append(video)
    content.element = container
    content.state = 'loaded'
  })
  // Native playback and seeking controls must not start a gallery drag.
  pswp.on('pointerDown', (event) => {
    if (event.originalEvent.target instanceof HTMLVideoElement)
      event.preventDefault()
  })
  pswp.on('contentActivate', ({ content }) => {
    const video = content.element?.querySelector('video')
    // Only the active slide plays; native controls remain available if blocked.
    if (video) void video.play().catch(() => {})
  })
  pswp.on('contentDeactivate', ({ content }) => {
    content.element?.querySelector('video')?.pause()
  })
  pswp.on('contentDestroy', ({ content }) => {
    const video = content.element?.querySelector('video')
    if (!video) return
    video.pause()
    video.removeAttribute('src')
    video.load()
    videos.delete(video)
  })
  pswp.on('close', () => {
    for (const video of videos) video.pause()
  })
  pswp.on('openingAnimationEnd', () => {
    if (disposed) pswp.destroy()
  })
  pswp.on('change', () => {
    index.value = pswp.currIndex
  })
  pswp.on('afterInit', () => {
    pswp.element?.removeAttribute('role')
    pswp.element?.removeAttribute('aria-modal')
  })
  // A cold list thumbnail may not know its natural size yet. Rebuilding a
  // slide during the opening animation lets the opener restore stale zoom
  // geometry, so defer the correction until it has finished.
  const pendingSizes = new Set<number>()
  let refreshQueued = false
  function refreshSizes() {
    if (disposed || !pswp.opener.isOpen || refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      if (disposed || !pswp.opener.isOpen) return
      const indices = [...pendingSizes]
      pendingSizes.clear()
      for (const index of indices) pswp.refreshSlideContent(index)
    })
  }
  pswp.on('contentLoadImage', ({ content }) => {
    const image = content.element
    if (!(image instanceof HTMLImageElement)) return
    const resolveSize = () => {
      if (disposed || !image.naturalWidth) return
      if (
        content.data.width === image.naturalWidth &&
        content.data.height === image.naturalHeight
      )
        return
      content.data.width = image.naturalWidth
      content.data.height = image.naturalHeight
      pendingSizes.add(content.index)
      refreshSizes()
    }
    // Also covers lazy neighboring slides, whose loadComplete event is not
    // dispatched until they have a slide, and already-cached image responses.
    image.addEventListener('load', resolveSize, { once: true })
    queueMicrotask(() => {
      if (image.complete) resolveSize()
    })
  })
  pswp.on('openingAnimationEnd', refreshSizes)
  pswp.on('destroy', () => {
    if (!disposed) emit('close')
  })
  pswp.init()
})
onBeforeUnmount(() => {
  disposed = true
  for (const video of videos) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  videos.clear()
  photoSwipe?.destroy()
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
watch(
  () => props.assets,
  () => emit('close'),
)
</script>

<template>
  <dialog
    ref="viewer"
    class="viewer"
    :aria-label="isVideo ? '视频预览' : '图片预览'"
    @cancel.prevent="close"
    @close="emit('close')"
    @keydown="keydown"
  >
    <!-- The dialog's initial focus lands on the canvas, not the close button:
         opening by tap must not leave a focus ring sitting on "close". Tab
         still reaches the controls, and their rings stay visible. -->
    <div ref="stage" class="stage" tabindex="-1" autofocus />

    <div class="chrome chrome-top">
      <button
        type="button"
        class="glass close"
        :aria-label="isVideo ? '关闭视频' : '关闭图片'"
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
        v-if="assets.length > 1"
        class="glass counter"
        role="status"
        aria-live="polite"
      >
        {{ index + 1 }} / {{ assets.length }}
      </p>
      <ViewerDetailButton
        v-if="selectedCollection"
        @select="emit('open', selectedCollection!)"
      />
      <button
        type="button"
        class="glass save"
        :disabled="saving"
        :aria-label="saving ? '准备中…' : '保存'"
        :aria-busy="saving"
        :title="saving ? '准备中…' : '保存'"
        @click="save"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path v-if="saving" d="M5 12h.01M12 12h.01M19 12h.01" />
          <path v-else d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
        </svg>
      </button>
    </div>
    <p v-if="saveError" class="save-error" role="alert">{{ saveError }}</p>

    <div
      v-if="selected?.alt_text || assets.length > 1"
      class="chrome chrome-bottom"
    >
      <p v-if="selected?.alt_text" class="caption">{{ selected.alt_text }}</p>
      <div v-if="assets.length > 1" class="glass remote">
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
        <span v-if="assets.length <= 8" class="dots" aria-hidden="true">
          <span
            v-for="(image, slot) in assets"
            :key="image.id"
            class="dot"
            :class="{ on: slot === index }"
          />
        </span>
        <button
          type="button"
          class="nav"
          :disabled="index === assets.length - 1"
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
/* Only the programmatic initial focus target; a ring here would be noise. */
.stage:focus {
  outline: none;
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

.stage :deep(.video-slide) {
  display: grid;
  place-items: center;
  color: var(--subtle);
}
.stage :deep(.video-slide video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
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
/* Keyboard users keep a clear ring on every control. */
.close:focus-visible,
.save:focus-visible,
.nav:focus-visible,
.caption:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.save {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  margin-left: auto;
  color: #fff;
  font-size: 15px;
}
.save:disabled {
  opacity: 0.5;
}
.save-error {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 64px);
  inset-inline: 14px;
  padding: 10px 14px;
  background: rgba(0, 0, 0, 0.8);
  border-radius: 12px;
  text-align: center;
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
