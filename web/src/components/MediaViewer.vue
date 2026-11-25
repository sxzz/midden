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
import { useRouter } from 'vue-router'
import {
  assetURL,
  errorText,
  previewURL,
  telegramDownload,
  type Asset,
  type Collection,
  type RemovalEffect,
} from '../api'
import { toast } from '../composables/useToast'
import { host } from '../host'
import {
  bottomBudget,
  captionLines,
  mediaInsets,
  type Chrome,
} from '../media-fit'
import { mediaRemovals } from '../media-removals'
import { navigatesHere } from '../navigation'
import { isRemoved, present } from '../presentation'
import { collectionHref, shareSlug } from '../share'
import { kindOf } from '../titles'
import MediaPreview from './MediaPreview.vue'
import MediaRemovalSheet from './MediaRemovalSheet.vue'
import ViewerDetailButton from './ui/ViewerDetailButton.vue'
import 'photoswipe/style.css'
// The API carries no dimensions, so an image's natural size is learned when it
// first loads and kept for the next time the same asset is opened.
const naturalSizes = new Map<string, { width: number; height: number }>()
const props = defineProps<{
  assets: Asset[]
  collection?: Collection
  collections?: Collection[]
  initialId: string
  /** The collection the media belongs to, or each item's own. */
  collectionId?: string
  collectionIds?: Record<string, string>
}>()
const emit = defineEmits<{ close: [] }>()
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
const menuOpen = shallowRef(false)
const removing = shallowRef(false)
// The same actions from every page, so what they need is read here rather
// than handed down: the owner's post media can be removed, which a public
// link, a profile picture (the server keeps those) or media without a
// collection to remove it from cannot.
const canRemove = computed(
  () =>
    !shareSlug.value &&
    !!selectedCollection.value &&
    !!selected.value &&
    (!selected.value.purpose || selected.value.purpose === 'banner'),
)
function askRemove() {
  menuOpen.value = false
  removing.value = true
}
function removed(effect: RemovalEffect) {
  removing.value = false
  toast(`已删除 ${effect.media} 个媒体`)
  mediaRemovals.value++
  emit('close')
}
// A slide shown before the opening animation ends never gets activated, and
// stays blank; moving waits for the viewer to be open.
const opened = shallowRef(false)
// Media belongs to a post unless its collection is known to be an account.
const detailKind = computed(() =>
  selectedCollection.value
    ? (kindOf(
        selectedCollection.value,
        props.collections?.find(
          (item) => item.id === selectedCollection.value,
        ) || props.collection,
      ) ?? 'post')
    : 'post',
)
watch(index, () => {
  menuOpen.value = false
})
const isVideo = computed(() => selected.value?.mime?.startsWith('video/'))
const videos = new Set<HTMLVideoElement>()
const dialog = useTemplateRef<HTMLDialogElement>('viewer')
const stage = useTemplateRef<HTMLDivElement>('stage')
const topBar = useTemplateRef<HTMLDivElement>('topBar')
const bottomBar = useTemplateRef<HTMLDivElement>('bottomBar')
const measurer = useTemplateRef<HTMLDivElement>('measurer')
const strip = useTemplateRef<HTMLDivElement>('strip')
const router = useRouter()
const saving = shallowRef(false)
const saveError = shallowRef('')
function save() {
  const image = selected.value
  if (!image || saving.value) return
  saveError.value = ''
  const tg = host()
  if (tg?.initData && tg.downloadFile && tg.isVersionAtLeast?.('8.0')) {
    saving.value = true
    try {
      if (!disposed) tg.downloadFile(telegramDownload(image))
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
/**
 * The author and text of the post an item belongs to, with the item's own
 * description: built as plain DOM because it lives inside the slide, so it
 * travels with the media when the slides move. It is one link to the post.
 */
function captionOf(slot: number) {
  const item = props.assets[slot]
  if (!item) return
  const id = props.collectionIds?.[item.id] || props.collectionId
  const source =
    props.collections?.find((entry) => entry.id === id) || props.collection
  const view = source ? present(source) : undefined
  if (!view && !item.alt_text) return
  const root = document.createElement('div')
  root.className = 'slide-caption'
  if (view) {
    const post = document.createElement(id ? 'a' : 'div')
    post.className = 'post-caption'
    if (post instanceof HTMLAnchorElement && id) post.href = collectionHref(id)
    const avatar = document.createElement('span')
    avatar.className = 'caption-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    if (view.avatar && !view.avatar.sensitive) {
      const image = document.createElement('img')
      image.alt = ''
      image.draggable = false
      image.src = previewURL(view.avatar)
      avatar.append(image)
    } else avatar.textContent = view.name.slice(0, 1)
    const content = document.createElement('span')
    content.className = 'caption-content'
    const author = document.createElement('strong')
    author.className = 'caption-author'
    author.textContent = view.name
    if (view.handle) {
      const handle = document.createElement('span')
      handle.textContent = ` @${view.handle}`
      author.append(handle)
    }
    content.append(author)
    if (view.body) {
      const body = document.createElement('span')
      body.className = 'caption-body'
      body.textContent = view.body
      content.append(body)
    }
    post.append(avatar, content)
    root.append(post)
  }
  if (item.alt_text) {
    const alt = document.createElement('p')
    alt.className = 'alt'
    alt.textContent = item.alt_text
    root.append(alt)
  }
  return root
}
// How tall each item's caption is at the current width, which the item's
// free area gives up; measured once off screen, as the slide that shows it
// is sized before it has the caption.
const captionHeights = new Map<number, number>()
let captionKey = ''
function captionHeight(slot: number) {
  const known = captionHeights.get(slot)
  if (known !== undefined) return known
  const caption = captionOf(slot)
  let height = 0
  if (caption && measurer.value) {
    measurer.value.append(caption)
    height = Math.ceil(caption.getBoundingClientRect().height)
    caption.remove()
  }
  captionHeights.set(slot, height)
  return height
}
/** A tap on the caption follows its link as AppLink does. */
function captionClick(event: MouseEvent) {
  const link = (event.target as Element).closest('a.post-caption')
  if (!(link instanceof HTMLAnchorElement) || !navigatesHere(event)) return
  event.preventDefault()
  emit('close')
  void router?.push(link.getAttribute('href')!.slice(1))
}

// The strip of thumbnails: scrolling it moves the viewer to the thumbnail
// at its centre, and the viewer moving scrolls it. `scrubbing` is true while
// a hand is on the strip and until its momentum ends, so the strip's own
// scrolling is never taken for the hand's.
let scrubbing = false
let settle: ReturnType<typeof setTimeout> | undefined
const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
function scrubFor(ms?: number) {
  scrubbing = true
  clearTimeout(settle)
  if (ms !== undefined)
    settle = setTimeout(() => {
      scrubbing = false
    }, ms)
}
const pitch = () => {
  const [first, second] = strip.value?.children ?? []
  return first instanceof HTMLElement && second instanceof HTMLElement
    ? second.offsetLeft - first.offsetLeft
    : 0
}
function stripScrolled() {
  if (!scrubbing || !opened.value || !strip.value) return
  scrubFor(160)
  const step = pitch()
  if (!step) return
  const slot = Math.min(
    props.assets.length - 1,
    Math.max(0, Math.round(strip.value.scrollLeft / step)),
  )
  if (slot !== index.value) photoSwipe?.goTo(slot)
}
function followStrip(smooth: boolean) {
  if (scrubbing || !strip.value) return
  const left = index.value * pitch()
  // (A document without layout, as in tests, cannot scroll smoothly.)
  if (smooth && !reducedMotion() && 'scrollTo' in strip.value)
    strip.value.scrollTo({ left, behavior: 'smooth' })
  else strip.value.scrollLeft = left
}
// A mouse drags the strip as a finger would.
let drag: { x: number; left: number; moved: boolean } | undefined
function dragStart(event: PointerEvent) {
  if (event.pointerType !== 'mouse' || !strip.value) return
  drag = { x: event.clientX, left: strip.value.scrollLeft, moved: false }
}
function dragMove(event: PointerEvent) {
  if (!drag || !strip.value) return
  const delta = event.clientX - drag.x
  if (!drag.moved && Math.abs(delta) > 4) {
    drag.moved = true
    scrubFor()
  }
  if (drag.moved) strip.value.scrollLeft = drag.left - delta
}
function dragEnd() {
  if (!drag) return
  if (drag.moved) {
    scrubFor(160)
    // The click that ends a drag is not a tap on a thumbnail.
    window.addEventListener('click', (e) => e.stopPropagation(), {
      capture: true,
      once: true,
    })
  }
  drag = undefined
}
function jump(slot: number) {
  if (opened.value) photoSwipe?.goTo(slot)
}
// What the floating bars take of the stage. Media is fitted in the rest, so at
// its default zoom it never lies under the text, the captions or the buttons.
let chrome: Chrome = { top: 0, bottom: 0, side: 0 }
let photoSwipe: PhotoSwipe | undefined
let resizeObserver: ResizeObserver | undefined
let previousOverflow = ''
let opener: HTMLElement | null = null
let disposed = false
function close() {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  if (!photoSwipe?.opener.isOpen) emit('close')
  else photoSwipe.close()
}
function move(delta: number) {
  if (!opened.value) return
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
// Reads the bars' sizes and how much text the room allows. Returns whether
// the free area changed since the last reading.
function measure(el: HTMLElement) {
  const top = topBar.value
  const bottom = bottomBar.value
  if (!top || !bottom) return false
  const height = el.clientHeight || window.innerHeight
  const topHeight = Math.ceil(top.getBoundingClientRect().height)
  const budget = bottomBudget(height, topHeight)
  const lines = captionLines(budget)
  const bottomHeight = Math.ceil(bottom.getBoundingClientRect().height)
  dialog.value?.style.setProperty('--caption-lines', String(lines))
  dialog.value?.style.setProperty('--chrome-bottom', `${bottomHeight}px`)
  if (dialog.value) dialog.value.dataset.lines = String(lines)
  // Captions wrap to the width and clamp to the lines, so a new width or
  // line count measures them again.
  const key = `${el.clientWidth}:${lines}`
  const reflowed = key !== captionKey
  if (reflowed) captionHeights.clear()
  captionKey = key
  const next: Chrome = {
    top: topHeight,
    bottom: bottomHeight,
    // The top bar's side padding already holds the safe areas.
    side: Number.parseFloat(getComputedStyle(top).paddingLeft) || 0,
  }
  const changed =
    reflowed ||
    next.top !== chrome.top ||
    next.bottom !== chrome.bottom ||
    next.side !== chrome.side
  chrome = next
  return changed
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
  stage.value.addEventListener('click', captionClick)
  // A tap anywhere but the menu and its button puts the menu away.
  dialog.value?.addEventListener(
    'pointerdown',
    (event) => {
      if (menuOpen.value && !(event.target as Element).closest('.menu, .more'))
        menuOpen.value = false
    },
    true,
  )
  const el = stage.value
  const assets = props.assets
  measure(el)
  // Slide geometry is decided in `calcSlideSize` below; these dimensions only
  // have to be non-zero for PhotoSwipe to treat the item as sized.
  const dataSource = assets.map((image) => {
    const video = image.mime?.startsWith('video/')
    return {
      src: assetURL(image),
      type: video ? 'video' : 'image',
      alt: image.alt_text || (video ? '收藏视频' : '收藏图片'),
      width: el.clientWidth || window.innerWidth,
      height: el.clientHeight || window.innerHeight,
    }
  })
  const pswp = new PhotoSwipe({
    dataSource,
    index: index.value,
    appendToEl: el,
    // The stage is the viewport, not the window: inside a host webview the two
    // can disagree, and the stage can change size without a window resize.
    getViewportSizeFn: () => ({
      x: el.clientWidth || window.innerWidth,
      y: el.clientHeight || window.innerHeight,
    }),
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
    // The default (fitted) zoom stays inside this padding; a zoomed image may
    // pan over it. A video has no zoom, so it never leaves it.
    paddingFn: (viewport, item, slot) =>
      mediaInsets(
        { width: viewport.x, height: viewport.y },
        chrome,
        item.type === 'video',
        captionHeight(slot),
      ),
    // A video cannot be pinched larger than its free area; 0 keeps PhotoSwipe's
    // own maximum for images.
    maxZoomLevel: (level) => (level.itemData.type === 'video' ? 1 : 0),
  })
  photoSwipe = pswp
  // The single place a slide gets its size, run again on every viewport
  // change. An image uses its natural size once known. Until then, and always
  // for a video, the slide fills the free area and object-fit contains the
  // media inside it, so nothing is ever shown at a guessed aspect ratio.
  pswp.on('calcSlideSize', ({ slide }) => {
    const asset = assets[slide.index]
    const size =
      slide.data.type === 'video'
        ? undefined
        : naturalSizes.get(asset?.id || '')
    slide.width = size?.width || slide.panAreaSize.x
    slide.height = size?.height || slide.panAreaSize.y
    slide.zoomLevels.update(slide.width, slide.height, slide.panAreaSize)
  })
  if (typeof ResizeObserver !== 'undefined') {
    // The stage follows the window, the host viewport and rotation; the bars
    // follow the text shown. Either one moves the free area.
    resizeObserver = new ResizeObserver(() => {
      if (disposed) return
      pswp.updateSize(measure(el))
    })
    resizeObserver.observe(el)
    if (topBar.value) resizeObserver.observe(topBar.value)
    if (bottomBar.value) resizeObserver.observe(bottomBar.value)
  }
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
    const target = event.originalEvent.target
    if (
      target instanceof HTMLVideoElement ||
      (target instanceof Element && target.closest('.slide-caption'))
    )
      event.preventDefault()
  })
  pswp.on('contentActivate', ({ content }) => {
    const video = content.element?.querySelector('video')
    // Only the active slide plays; native controls remain available if blocked.
    if (video) void video.play().catch(() => {})
  })
  // The caption is a child of the slide's holder, so it moves with it.
  pswp.on('afterSetContent', ({ slide }) => {
    const holder = slide.holderElement
    if (!holder) return
    holder.querySelector(':scope > .slide-caption')?.remove()
    const caption = captionOf(slide.index)
    if (caption) holder.append(caption)
  })
  pswp.on('slideDestroy', ({ slide }) => {
    slide.holderElement?.querySelector(':scope > .slide-caption')?.remove()
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
    else opened.value = true
  })
  pswp.on('change', () => {
    index.value = pswp.currIndex
    followStrip(true)
  })
  pswp.on('afterInit', () => {
    pswp.element?.removeAttribute('role')
    pswp.element?.removeAttribute('aria-modal')
  })
  // Resizing a slide during the opening animation lets the opener restore
  // stale zoom geometry, so a size learned meanwhile is applied afterwards.
  const pendingSlides = new Set<number>()
  function resizeSlide(index: number) {
    if (disposed) return
    if (pswp.opener.isOpening) {
      pendingSlides.add(index)
      return
    }
    for (const holder of pswp.mainScroll.itemHolders)
      if (holder.slide?.index === index) holder.slide.resize()
  }
  pswp.on('contentLoadImage', ({ content }) => {
    const image = content.element
    const id = assets[content.index]?.id
    if (!(image instanceof HTMLImageElement) || !id) return
    const resolveSize = () => {
      if (disposed || !image.naturalWidth) return
      const known = naturalSizes.get(id)
      if (
        known?.width === image.naturalWidth &&
        known.height === image.naturalHeight
      )
        return
      naturalSizes.set(id, {
        width: image.naturalWidth,
        height: image.naturalHeight,
      })
      resizeSlide(content.index)
    }
    // Also covers lazy neighboring slides, whose loadComplete event is not
    // dispatched until they have a slide, and already-cached image responses.
    image.addEventListener('load', resolveSize, { once: true })
    queueMicrotask(() => {
      if (image.complete) resolveSize()
    })
  })
  pswp.on('openingAnimationEnd', () => {
    const indices = [...pendingSlides]
    pendingSlides.clear()
    for (const index of indices) resizeSlide(index)
  })
  pswp.on('destroy', () => {
    if (!disposed) emit('close')
  })
  pswp.init()
  followStrip(false)
})
onBeforeUnmount(() => {
  disposed = true
  for (const video of videos) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  videos.clear()
  resizeObserver?.disconnect()
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

    <div ref="topBar" class="chrome chrome-top">
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
      <!-- One capsule of icon buttons, as in the iOS toolbar. -->
      <div class="glass actions" role="toolbar" aria-label="操作">
        <ViewerDetailButton
          v-if="selectedCollection"
          :href="collectionHref(selectedCollection)"
          :kind="detailKind"
          @navigate="emit('close')"
        />
        <button
          type="button"
          class="bar-button save"
          :disabled="saving"
          :aria-label="saving ? '准备中…' : '下载'"
          :aria-busy="saving"
          :title="saving ? '准备中…' : '下载'"
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
        <button
          v-if="canRemove"
          type="button"
          class="bar-button more"
          aria-label="更多"
          title="更多"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <circle cx="5.5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="18.5" cy="12" r="1.6" />
          </svg>
        </button>
        <div v-if="menuOpen" class="menu" role="menu" aria-label="更多">
          <button
            type="button"
            role="menuitem"
            class="danger"
            @click="askRemove"
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
              <path
                d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"
              />
            </svg>
            删除此媒体
          </button>
        </div>
      </div>
    </div>
    <p v-if="saveError" class="save-error" role="alert">{{ saveError }}</p>

    <!-- Always in the page, so the room it leaves is always read: the strip of
         thumbnails when there are several items, else just the safe area. -->
    <div ref="bottomBar" class="chrome chrome-bottom">
      <div
        v-if="assets.length > 1"
        ref="strip"
        class="strip"
        role="group"
        aria-label="媒体缩略图"
        @scroll.passive="stripScrolled"
        @touchstart.passive="scrubFor()"
        @touchend.passive="scrubFor(300)"
        @touchcancel.passive="scrubFor(300)"
        @wheel.passive="scrubFor(300)"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
      >
        <button
          v-for="(item, slot) in assets"
          :key="item.id"
          type="button"
          class="thumb"
          :class="{ on: slot === index, removed: isRemoved(item) }"
          :disabled="!opened"
          :aria-label="`第 ${slot + 1} 项，共 ${assets.length} 项`"
          :aria-current="slot === index || undefined"
          @click="jump(slot)"
        >
          <MediaPreview :asset="item" thumbnail />
        </button>
      </div>
    </div>
    <!-- Off screen: captions are measured here before their slides exist. -->
    <div ref="measurer" class="measurer" aria-hidden="true" />

    <MediaRemovalSheet
      v-if="selectedCollection && selected"
      :open="removing"
      :target="{ collection: selectedCollection, asset: selected.id }"
      title="删除此媒体？"
      @removed="removed"
      @cancel="removing = false"
    />
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
  object-fit: contain;
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
  /* A definite track: an auto one grows to the video's own height, so a clip
     taller than the slide would overflow it instead of being contained. */
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
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
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: calc(env(safe-area-inset-top, 0px) + 12px)
    calc(env(safe-area-inset-right, 0px) + 14px) 12px
    calc(env(safe-area-inset-left, 0px) + 14px);
}
.chrome-bottom {
  bottom: 0;
  padding: 10px 0 calc(env(safe-area-inset-bottom, 0px) + 8px);
  background: rgba(0, 0, 0, 0.55);
}
/* The thumbnails, as in the iOS Photos viewer: the item shown sits in the
   middle, the rest scroll past it. Scrolling is native, with snapping. */
.strip {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  /* Half a strip each side lets the first and the last thumbnail centre. */
  padding: 4px calc(50% - 18px);
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
  touch-action: pan-x;
  pointer-events: auto;
  cursor: grab;
  -webkit-user-select: none;
  user-select: none;
}
.strip::-webkit-scrollbar {
  display: none;
}
.thumb {
  position: relative;
  flex: none;
  width: 36px;
  height: 48px;
  overflow: hidden;
  border-radius: 6px;
  background: #1c1c1e;
  opacity: 0.55;
  scroll-snap-align: center;
  transform: scale(0.92);
  transition:
    transform 200ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 200ms ease;
}
.thumb.on {
  opacity: 1;
  transform: scale(1.2);
  box-shadow: 0 0 0 1.5px #fff;
  z-index: 1;
}
.thumb:disabled {
  cursor: default;
}
.thumb :deep(.media-preview) {
  height: 100%;
}
.thumb :deep(img),
.thumb :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}
/* Media removed to save space shows by the thumbnail it kept, dimmed. */
.thumb.removed :deep(img) {
  filter: grayscale(1) brightness(0.7);
}
.measurer {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
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
  grid-column: 1;
  justify-self: start;
  width: 44px;
  height: 44px;
  color: #fff;
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
.close:active {
  transform: scale(0.9);
}
/* The viewer's actions, one capsule of evenly spaced icon buttons. */
.actions {
  position: relative;
  display: flex;
  align-items: center;
  grid-column: 3;
  justify-self: end;
  gap: 2px;
  padding: 3px;
  color: #fff;
}
.bar-button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 50%;
  color: #fff;
  transition:
    transform 220ms cubic-bezier(0.32, 0.72, 0, 1),
    background-color 160ms ease;
}
.bar-button:active:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.16);
  transform: scale(0.9);
}
.bar-button:disabled {
  opacity: 0.5;
}
.bar-button[aria-expanded='true'] {
  background-color: rgba(255, 255, 255, 0.16);
}
/* Keyboard users keep a clear ring on every control. */
.close:focus-visible,
.bar-button:focus-visible,
.thumb:focus-visible,
.menu button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.menu {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  min-width: 176px;
  padding: 6px;
  border-radius: 18px;
  background-color: rgba(34, 34, 36, 0.94);
  box-shadow:
    inset 0 0 0 0.5px rgba(255, 255, 255, 0.12),
    0 12px 36px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(26px) saturate(180%);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  pointer-events: auto;
}
.menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  font-size: 16px;
  white-space: nowrap;
}
.menu button:active {
  background-color: rgba(255, 255, 255, 0.12);
}
.menu .danger {
  color: #ff6a6a;
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
  grid-column: 2;
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
.icon {
  display: block;
  width: 21px;
  height: 21px;
}

/* style.css already neutralises durations; restated so the intent is local. */
@media (prefers-reduced-motion: reduce) {
  .thumb,
  .bar-button,
  .close {
    transition: none;
  }
}
</style>

<style>
/* The caption is built as DOM inside each slide, so scoped styles cannot
   reach it. */
.viewer .slide-caption {
  display: grid;
  gap: 4px;
  justify-items: center;
  padding: 24px calc(env(safe-area-inset-right, 0px) + 14px) 8px
    calc(env(safe-area-inset-left, 0px) + 14px);
  color: #fff;
}
.viewer .pswp__item > .slide-caption {
  position: absolute;
  right: 0;
  bottom: var(--chrome-bottom, 0px);
  left: 0;
  z-index: 2;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
}
.viewer .post-caption {
  display: flex;
  gap: 10px;
  width: min(100%, 760px);
  color: #fff;
  text-align: left;
  text-decoration: none;
  pointer-events: auto;
}
.viewer .caption-avatar {
  display: grid;
  place-items: center;
  align-self: start;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.15);
}
.viewer .caption-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.viewer .caption-content {
  flex: 1;
  min-width: 0;
}
.viewer .caption-author {
  display: block;
  overflow: hidden;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.viewer .caption-author span {
  color: rgba(235, 235, 245, 0.6);
  font-weight: 400;
}
/* A few lines of the post, ended by an ellipsis; the post has the rest. The
   count follows the room left (see captionLines). */
.viewer .caption-body {
  display: -webkit-box;
  -webkit-line-clamp: var(--caption-lines, 3);
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 2px;
  font-size: 14px;
  line-height: 1.45;
}
.viewer .slide-caption .alt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  max-width: 640px;
  margin: 0;
  overflow: hidden;
  color: rgba(235, 235, 245, 0.78);
  font-size: 13px;
  line-height: 1.45;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}
/* In a short viewport the post's text is all there is room for. */
.viewer[data-lines='1'] .slide-caption .alt {
  display: none;
}
</style>
