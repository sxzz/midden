<script setup vapor lang="ts">
import { computed, onActivated, onUnmounted, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  previewURL,
  type Asset,
  type ProfileChanges,
} from '../api'
import { changeDays, lineNote, type ImageLine } from '../changes'
import MediaViewer from './MediaViewer.vue'
import EyeIcon from './ui/EyeIcon.vue'
import LoadingImage from './ui/LoadingImage.vue'
import LockIcon from './ui/LockIcon.vue'
import Spinner from './ui/Spinner.vue'
const props = defineProps<{ id: string; showSensitive?: boolean }>()
const changes = shallowRef<ProfileChanges>()
const error = shallowRef('')
const loading = shallowRef(false)
let controller = new AbortController()
async function load() {
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  try {
    const result = await call(
      client.collections[':id']['profile-changes'].$get(
        { param: { id: props.id }, query: {} },
        { init: { signal } },
      ),
    )
    if (signal.aborted) return
    changes.value = result
    error.value = ''
  } catch (e) {
    if (!signal.aborted) error.value = errorText(e)
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(
  () => props.id,
  () => {
    changes.value = undefined
    void load()
  },
  { immediate: true },
)
// Kept in the navigation cache: coming back after a refresh shows its change.
let mounted = false
onActivated(() => {
  if (mounted) void load()
  mounted = true
})
onUnmounted(() => controller.abort())
const days = computed(() => changeDays(changes.value))

// Sensitive images stay covered until tapped, unless all are shown.
const revealed = shallowRef<string[]>([])
watch(
  () => props.showSensitive,
  () => (revealed.value = []),
)
const hidden = (asset: Asset) =>
  asset.sensitive && !props.showSensitive && !revealed.value.includes(asset.id)
const sides = (line: ImageLine) => [
  ...(line.before ? [{ side: '原', asset: line.before }] : []),
  ...(line.after ? [{ side: '新', asset: line.after }] : []),
]
/** The images of the line being looked at, and which one. */
const viewing = shallowRef<{ assets: Asset[]; id: string }>()
function open(line: ImageLine, asset: Asset) {
  if (hidden(asset)) {
    revealed.value = [...revealed.value, asset.id]
    return
  }
  const assets = [line.before, line.after].filter(
    (a): a is Asset => !!a && !hidden(a),
  )
  viewing.value = { assets, id: asset.id }
}
</script>

<template>
  <div class="changes">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <p v-if="!changes && loading" class="loading">
      <Spinner label="正在加载" />
    </p>
    <section
      v-for="day in days"
      :key="day.label"
      class="day"
      :class="{ fetching: loading }"
    >
      <h2 class="day-label">{{ day.label }}</h2>
      <ol class="timeline">
        <li v-for="entry in day.entries" :key="entry.id" class="entry">
          <time class="time" :datetime="entry.datetime">{{ entry.time }}</time>
          <div class="card">
            <div v-for="line in entry.lines" :key="line.key" class="line">
              <p v-if="line.kind === 'flag'" class="flag">
                <LockIcon v-if="line.locked" />{{ line.label }}
              </p>
              <template v-else>
                <p class="label">
                  {{ line.label
                  }}<span v-if="lineNote(line)" class="note">{{
                    lineNote(line)
                  }}</span>
                </p>
                <template v-if="line.kind === 'text'">
                  <p v-if="line.before" class="value before">
                    <span class="mark" aria-hidden="true">原</span
                    ><del>{{ line.before }}</del>
                  </p>
                  <p v-if="line.after" class="value after">
                    <span class="mark" aria-hidden="true">新</span
                    ><ins>{{ line.after }}</ins>
                  </p>
                </template>
                <div v-else class="images" :class="line.shape">
                  <!-- Old then new, an arrow between them when both exist. -->
                  <span
                    v-for="image in sides(line)"
                    :key="image.asset.id"
                    class="side"
                  >
                    <button
                      type="button"
                      class="image"
                      :class="{ blurred: hidden(image.asset) }"
                      :aria-label="
                        hidden(image.asset)
                          ? '敏感内容，点按显示'
                          : `放大${image.side}${line.label}`
                      "
                      @click="open(line, image.asset)"
                    >
                      <LoadingImage :src="previewURL(image.asset)" alt="" />
                      <span v-if="hidden(image.asset)" class="veil"
                        ><EyeIcon
                      /></span>
                    </button>
                  </span>
                </div>
              </template>
            </div>
          </div>
        </li>
      </ol>
    </section>
    <p v-if="changes?.truncated" class="footnote">
      只比较了最近 1000 个版本，更早的修改未列出。
    </p>
    <MediaViewer
      v-if="viewing"
      :assets="viewing.assets"
      :initial-id="viewing.id"
      @close="viewing = undefined"
    />
  </div>
</template>

<style scoped>
.changes {
  padding: 0 var(--gutter);
}
.banner {
  margin: 0 0 16px;
  padding: 14px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
  line-height: 1.5;
}
.loading {
  margin: 0;
  padding-top: 32px;
  text-align: center;
  color: var(--subtle);
}
.day {
  margin: 0 0 18px;
  transition: opacity 0.2s ease;
}
/* A refetch keeps the list in place, dimmed, rather than flashing. */
.day.fetching {
  opacity: 0.6;
}
.day-label {
  margin: 0 0 8px;
  padding: 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--subtle);
}
.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
}
/* A rail down the left joins a day's entries, a dot marks each one. */
.entry {
  position: relative;
  padding: 0 0 12px 20px;
}
.entry::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: -6px;
  width: 2px;
  background: var(--separator);
}
.entry:last-child {
  padding-bottom: 0;
}
.entry:last-child::before {
  bottom: auto;
  height: 0;
}
.entry::after {
  content: '';
  position: absolute;
  left: 0;
  top: 5px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--link);
}
.time {
  display: block;
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.card {
  background: var(--card);
  border-radius: var(--radius);
  overflow: hidden;
}
.line {
  padding: 12px var(--inset);
}
.line + .line {
  border-top: 1px solid var(--separator);
}
.label,
.flag {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--subtle);
}
.flag {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  color: var(--text);
}
.note {
  margin-left: 6px;
  font-weight: 400;
}
.note::before {
  content: '· ';
}
.value {
  display: flex;
  gap: 8px;
  margin: 6px 0 0;
  font-size: 15px;
  line-height: 1.5;
}
.mark {
  flex: none;
  font-size: 12px;
  line-height: 22px;
  color: var(--subtle);
}
.value del,
.value ins {
  min-width: 0;
  text-decoration: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.before del {
  color: var(--subtle);
}
.images {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 0;
}
.side {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.side + .side::before {
  content: '→';
  color: var(--subtle);
}
.image {
  position: relative;
  flex: none;
  overflow: hidden;
  background: var(--fill);
}
.image:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.round .image {
  width: 56px;
  height: 56px;
  border-radius: 50%;
}
/* Banners are about 3:1, old and new alike in size: two side by side, with
   the arrow between them, fit the card on a phone. */
.wide {
  container-type: inline-size;
}
.wide .image {
  width: min(200px, calc((100cqi - 40px) / 2));
  aspect-ratio: 3;
  border-radius: 6px;
}
.image :deep(.image-shell) {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
}
.image.blurred :deep(img) {
  filter: blur(8px);
  transform: scale(1.2);
}
.veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
}
.footnote {
  margin: 0;
  padding: 0 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
</style>
