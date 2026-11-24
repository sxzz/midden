<script setup vapor lang="ts">
import { computed } from 'vue'
import { previewURL } from '../api'
import {
  kindLabels,
  viewerLine,
  type GraphKind,
  type GraphNodeView,
} from '../graph'
import { formatCount } from '../trends'
import LoadingImage from './ui/LoadingImage.vue'
import ViewerMark from './ViewerMark.vue'
// The account tapped in the graph: who it is, its own counts, and where to
// go from it. Only a saved profile the page may link to offers to go.
const props = defineProps<{
  view: GraphNodeView
  showSensitive?: boolean
  /** The chosen viewer's name, for the line on how it relates. */
  viewerName?: string
}>()
const emit = defineEmits<{
  center: [id: string]
  open: [id: string]
  close: []
}>()
const node = computed(() => props.view.node)
const avatar = computed(() =>
  node.value.avatar ? previewURL(node.value.avatar) : '',
)
const blurred = computed(
  () => !!node.value.avatar?.sensitive && !props.showSensitive,
)
/** The kind of a profile's graph; a comparison says more in its slot. */
const kind = computed(() =>
  props.view.kind && props.view.kind in kindLabels
    ? (props.view.kind as GraphKind)
    : undefined,
)
const viewerText = computed(() =>
  props.view.viewer && props.viewerName
    ? viewerLine(props.view.viewer, props.viewerName)
    : '',
)
const counts = computed(() => {
  const parts: string[] = []
  if (node.value.following !== undefined)
    parts.push(`关注 ${formatCount(node.value.following)}`)
  if (node.value.followers !== undefined)
    parts.push(`粉丝 ${formatCount(node.value.followers)}`)
  return parts
})
</script>

<template>
  <section class="card" aria-label="账号">
    <div class="who">
      <span class="avatar" :class="{ blurred }">
        <LoadingImage v-if="avatar" :src="avatar" alt="" />
        <span v-else class="initial" aria-hidden="true">{{
          view.initial
        }}</span>
      </span>
      <span class="names">
        <span class="name">{{ view.label }}</span>
        <span v-if="node.name && node.username" class="handle"
          >@{{ node.username }}</span
        >
        <span v-if="counts.length || kind" class="meta">
          <span v-if="kind" class="kind" :class="kind">{{
            kindLabels[kind]
          }}</span>
          <span v-for="part in counts" :key="part">{{ part }}</span>
        </span>
        <span v-if="viewerText" class="viewer"
          ><ViewerMark :relation="view.viewer!" />{{ viewerText }}</span
        >
        <slot />
      </span>
      <button
        type="button"
        class="close"
        aria-label="关闭"
        title="关闭"
        @click="emit('close')"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
    <div v-if="node.collection_id" class="actions">
      <button
        v-if="!view.center"
        type="button"
        @click="emit('center', node.collection_id)"
      >
        以他为中心
      </button>
      <button type="button" @click="emit('open', node.collection_id)">
        打开详情
      </button>
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--card);
  border-radius: 14px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.who {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 8px 14px var(--inset);
}
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--fill);
}
.avatar :deep(.image-shell) {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
}
.avatar.blurred :deep(img) {
  filter: blur(6px);
  transform: scale(1.2);
}
.initial {
  font-size: 20px;
  font-weight: 600;
}
.names {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-right: auto;
}
.name,
.handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name {
  font-size: 16px;
  font-weight: 600;
}
.handle,
.meta {
  font-size: 13px;
  color: var(--subtle);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.kind.following {
  color: #2f7fd8;
}
.kind.followers {
  color: #d9822b;
}
.kind.mutual {
  color: #2e9e5b;
}
.viewer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 13px;
}
.viewer :deep(.viewer-mark) {
  width: 16px;
  height: 16px;
  box-shadow: none;
}
.close {
  flex: none;
  display: grid;
  place-items: center;
  align-self: flex-start;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--subtle);
}
.close:active {
  background: var(--fill);
}
.actions {
  display: flex;
  box-shadow: inset 0 1px 0 var(--separator);
}
.actions button {
  flex: 1;
  min-height: 48px;
  font-size: 16px;
  text-align: center;
  color: var(--link);
}
.actions button + button {
  box-shadow: inset 1px 0 0 var(--separator);
}
.actions button:active {
  background: var(--fill);
}
button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
</style>
