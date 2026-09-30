<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { assetURL, type Collection } from '../api'
import { present, storageSize, warningList } from '../presentation'
import MediaGallery from './MediaGallery.vue'
import MediaViewer from './MediaViewer.vue'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{
  collection: Collection
  showSensitive?: boolean
}>()
const view = computed(() => present(props.collection))
const previewAvatar = shallowRef(false)
const avatarAssets = computed(() =>
  view.value.avatar && (!view.value.avatar.sensitive || props.showSensitive)
    ? [view.value.avatar]
    : [],
)
watch(avatarAssets, () => {
  previewAvatar.value = false
})
const warnings = computed(() => warningList(props.collection.warnings))
</script>

<template>
  <article class="post">
    <header class="author">
      <button
        v-if="avatarAssets.length"
        type="button"
        class="avatar avatar-button"
        :aria-label="`查看${view.name}的头像`"
        @click="previewAvatar = true"
      >
        <LoadingImage
          class="avatar"
          :src="assetURL(avatarAssets[0]!)"
          alt=""
        /></button
      ><span v-else class="avatar initials" aria-hidden="true">{{
        view.name.slice(0, 1)
      }}</span>
      <div class="identity">
        <strong class="name">{{ view.name }}</strong>
        <small v-if="view.handle" class="handle">@{{ view.handle }}</small>
      </div>
    </header>
    <p
      v-if="collection.storage_bytes !== undefined"
      class="storage"
      title="包含正文、历史版本、媒体及原始响应；共享文件在每条收藏中分别计入"
    >
      占用 {{ storageSize(collection.storage_bytes) }}
    </p>
    <p class="body">{{ view.body }}</p>
    <MediaGallery
      :assets="collection.assets || []"
      :show-sensitive="showSensitive"
    />
    <p v-for="warning in warnings" :key="warning" class="warning">
      {{ warning }}
    </p>
    <footer v-if="view.stats || view.details.length" class="record">
      <dl v-if="view.stats" class="stats" :aria-label="view.stats.label">
        <div v-for="stat in view.stats.items" :key="stat.label" class="stat">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
      <p v-if="view.details.length" class="details">
        <span v-for="detail in view.details" :key="detail.key" class="detail"
          ><span v-if="detail.label" class="label">{{ detail.label }}</span
          ><time v-if="detail.datetime" :datetime="detail.datetime">{{
            detail.value
          }}</time
          ><span v-else>{{ detail.value }}</span></span
        >
      </p>
    </footer>
    <MediaViewer
      v-if="previewAvatar && avatarAssets.length"
      :assets="avatarAssets"
      :initial-id="avatarAssets[0]!.id"
      @close="previewAvatar = false"
    />
  </article>
</template>

<style scoped>
.post {
  padding: 14px var(--inset) 16px;
}
.author {
  display: flex;
  gap: 12px;
  align-items: center;
}
.avatar {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill);
}
.avatar-button {
  padding: 0;
}
.avatar-button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 3px;
}
.image-shell.avatar {
  min-height: 0;
}
.initials {
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--link);
}
.identity {
  min-width: 0;
  flex: 1;
}
.name {
  display: block;
  font-size: 16px;
  font-weight: 600;
}
.handle {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.storage {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--subtle);
}
.body {
  margin: 12px 0 0;
  font-size: 16px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.warning {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
/* What the source recorded, kept under the post behind a hairline. */
.record {
  margin-top: 14px;
  padding-top: 11px;
  border-top: 1px solid var(--separator);
}
/* Wrap whole statistics into new rows, never split a number. */
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 12px;
  margin: 0;
}
/* Counts and timeline are two layers, so separate them when both are here. */
.stats:not(:last-child) {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--separator);
}
/* Count above, label below: the number is what the reader scans for. */
.stat {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  flex: 1 0 88px;
}
.stat dt {
  font-size: 12px;
  line-height: 1.3;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.stat dd {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 360px) {
  .stat dd {
    font-size: 16px;
  }
}
.details {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--subtle);
}
/* One fact per line: fixed label column on the left, value on the right. */
.detail {
  display: flex;
  gap: 8px;
}
.detail .label {
  flex: 0 0 3.2em;
}
.detail time {
  font-variant-numeric: tabular-nums;
}
</style>
