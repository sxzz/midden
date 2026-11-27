<script setup vapor lang="ts">
import { computed, onActivated, onUnmounted, shallowRef, watch } from 'vue'
import { errorText, previewURL, type Asset, type ProfileChanges } from '../api'
import {
  changeDays,
  lineNote,
  postLabel,
  type ImageLine,
  type PostsLine,
} from '../changes'
import { useHistory } from '../composables/useHistory'
import { toast } from '../composables/useToast'
import { readCollection, readProfileChanges } from '../reads'
import { collectionRoute } from '../share'
import CollectionPost from './CollectionPost.vue'
import MediaViewer from './MediaViewer.vue'
import RevisionTimeline from './RevisionTimeline.vue'
import AppLink from './ui/AppLink.vue'
import EyeIcon from './ui/EyeIcon.vue'
import LoadingImage from './ui/LoadingImage.vue'
import LockIcon from './ui/LockIcon.vue'
import SkeletonRows from './ui/SkeletonRows.vue'
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
    const result = await readProfileChanges(props.id, undefined, signal)
    if (signal.aborted) return
    changes.value = result
    error.value = ''
  } catch (e) {
    if (!signal.aborted) error.value = errorText(e)
  } finally {
    if (!signal.aborted) loading.value = false
  }
}

/**
 * The profile at each point of its history, moved through with the
 * timeline; the detail page shows only the current one.
 */
let historyController = new AbortController()
const history = useHistory(() => props.id, {
  signal: () => historyController.signal,
  report: (e) => toast(errorText(e)),
})
const {
  collection: shown,
  points,
  next,
  shownPoint,
  latestPoint,
  historyLoading,
  loadingPoint,
} = history
async function loadHistory() {
  const { signal } = historyController
  try {
    const result = await readCollection(props.id, signal)
    if (signal.aborted) return
    history.show(result)
    void history.historyPage()
  } catch {
    // The list of changes says what went wrong; without the profile there
    // is no timeline to show.
  }
}

watch(
  () => props.id,
  () => {
    changes.value = undefined
    void load()
    historyController.abort()
    historyController = new AbortController()
    history.reset()
    void loadHistory()
  },
  { immediate: true },
)
// Kept in the navigation cache: coming back after a refresh shows its change.
let mounted = false
onActivated(() => {
  if (mounted) {
    void load()
    void loadHistory()
  }
  mounted = true
})
onUnmounted(() => {
  controller.abort()
  historyController.abort()
})
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
/** The pinned posts before, then after, each under its mark. */
const postSides = (line: PostsLine) => [
  ...line.before.map((post) => ({ side: '原', key: `b${post.id}`, post })),
  ...line.after.map((post) => ({ side: '新', key: `a${post.id}`, post })),
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
    <template v-if="!changes && loading">
      <SkeletonRows title :rows="3" avatar hint label="正在读取变化" />
      <SkeletonRows title :rows="2" avatar hint />
    </template>
    <!-- The profile at the point the timeline rests on. -->
    <section v-if="shown && points.length > 1" class="versions">
      <h2 class="heading">资料版本</h2>
      <div class="card">
        <CollectionPost
          :class="{ fetching: loadingPoint }"
          :collection="shown"
          :show-sensitive="showSensitive"
          history
        />
        <div class="slider">
          <RevisionTimeline
            :points="points"
            :selected-id="shownPoint"
            :latest-id="latestPoint"
            :more="!!next"
            :loading="historyLoading"
            label="资料版本"
            @select="history.preview"
            @more="history.historyPage(true)"
          />
        </div>
      </div>
    </section>
    <section
      v-for="day in days"
      :key="day.label"
      class="day"
      :class="{ fetching: loading }"
    >
      <h2 class="heading day-label">{{ day.label }}</h2>
      <ol class="entries">
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
                <template v-else-if="line.kind === 'posts'">
                  <!-- Each post links to its collection when saved, else to
                       the platform. -->
                  <p
                    v-for="post in postSides(line)"
                    :key="post.key"
                    class="value post"
                    :class="post.side === '原' ? 'before' : 'after'"
                  >
                    <span class="mark" aria-hidden="true">{{
                      post.side
                    }}</span><AppLink
                      v-if="post.post.collection_id"
                      :to="collectionRoute(post.post.collection_id)"
                      class="post-link"
                      >{{ postLabel(post.post) }}</AppLink
                    ><AppLink
                      v-else-if="post.post.url"
                      :href="post.post.url"
                      class="post-link"
                      >{{ postLabel(post.post) }}</AppLink
                    ><span v-else class="post-link">{{
                      postLabel(post.post)
                    }}</span>
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
      :collection-id="id"
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
.day {
  margin: 0 0 18px;
  transition: opacity 0.2s ease;
}
/* A refetch keeps the list in place, dimmed, rather than flashing. */
.day.fetching {
  opacity: 0.6;
}
.versions {
  margin: 0 0 22px;
}
.slider {
  border-top: 1px solid var(--separator);
}
/* The post stays on screen while the timeline fetches a point. */
.versions .fetching {
  opacity: 0.6;
  transition: opacity 0.2s ease 0.1s;
}
.heading {
  margin: 0 0 8px;
  padding: 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--subtle);
}
.entries {
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
/* A post reads as its link, two lines at most. */
.post-link {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  color: var(--link);
  text-decoration: none;
  overflow-wrap: anywhere;
}
span.post-link {
  color: inherit;
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
