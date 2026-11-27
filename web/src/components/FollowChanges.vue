<script setup vapor lang="ts">
import { computed, onActivated, onUnmounted, shallowRef, watch } from 'vue'
import {
  errorText,
  previewURL,
  type FollowAccount,
  type FollowChanges,
} from '../api'
import { accountName, followDays, moment } from '../follows'
import { readFollowChanges } from '../reads'
import { collectionRoute } from '../share'
import AppLink from './ui/AppLink.vue'
import LoadingImage from './ui/LoadingImage.vue'
import RefreshButton from './ui/RefreshButton.vue'
import SkeletonRows from './ui/SkeletonRows.vue'
const props = defineProps<{ id: string; showSensitive?: boolean }>()
const changes = shallowRef<FollowChanges>()
const error = shallowRef('')
const loading = shallowRef(false)
let controller = new AbortController()
async function load() {
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  try {
    const result = await readFollowChanges(props.id, undefined, signal)
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
// Kept in the navigation cache: coming back after an update shows its changes.
let mounted = false
onActivated(() => {
  if (mounted) void load()
  mounted = true
})
onUnmounted(() => controller.abort())
const days = computed(() => followDays(changes.value))
// A sensitive avatar stays blurred unless all sensitive media are shown.
const blurred = (account: FollowAccount) =>
  !!account.avatar?.sensitive && !props.showSensitive
</script>

<template>
  <div class="changes">
    <div class="tools">
      <RefreshButton :busy="loading && !!changes" @refresh="load" />
    </div>
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <template v-if="!changes && loading">
      <SkeletonRows title :rows="3" avatar hint label="正在读取变化" />
      <SkeletonRows title :rows="2" avatar hint />
    </template>
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
            <div v-for="line in entry.lines" :key="line.type" class="line">
              <p class="label">
                {{ line.label }} {{ line.accounts.length
                }}<span v-if="line.since" class="note"
                  >{{ moment(line.since) }} 之后</span
                >
              </p>
              <ul class="accounts">
                <li
                  v-for="account in line.accounts"
                  :key="account.entity_id"
                  class="account"
                >
                  <AppLink
                    v-if="account.collection_id"
                    class="account-row"
                    :to="collectionRoute(account.collection_id)"
                  >
                    <span class="avatar" :class="{ blurred: blurred(account) }">
                      <LoadingImage
                        v-if="account.avatar"
                        :src="previewURL(account.avatar)"
                        alt=""
                      />
                    </span>
                    <span class="names">
                      <span
                        class="name"
                        :lang="account.name ? account.lang : undefined"
                        >{{ accountName(account) }}</span
                      >
                      <span
                        v-if="account.name && account.username"
                        class="handle"
                        >@{{ account.username }}</span
                      >
                    </span>
                  </AppLink>
                  <span v-else class="account-row">
                    <span class="avatar" :class="{ blurred: blurred(account) }">
                      <LoadingImage
                        v-if="account.avatar"
                        :src="previewURL(account.avatar)"
                        alt=""
                      />
                    </span>
                    <span class="names">
                      <span
                        class="name"
                        :lang="account.name ? account.lang : undefined"
                        >{{ accountName(account) }}</span
                      >
                      <span
                        v-if="account.name && account.username"
                        class="handle"
                        >@{{ account.username }}</span
                      >
                    </span>
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </li>
      </ol>
    </section>
    <p v-if="changes?.truncated" class="footnote">只列出最近 1000 条变化。</p>
  </div>
</template>

<style scoped>
.tools {
  display: flex;
  justify-content: flex-end;
  margin: 0 var(--gutter);
}
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
  padding: 12px var(--inset) 6px;
}
.line + .line {
  border-top: 1px solid var(--separator);
}
.label {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--subtle);
}
.note {
  margin-left: 6px;
  font-weight: 400;
}
.note::before {
  content: '· ';
}
.accounts {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.account-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 4px 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
}
a.account-row:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.avatar {
  flex: none;
  width: 32px;
  height: 32px;
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
.names {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name,
.handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name {
  font-size: 15px;
}
.handle {
  font-size: 13px;
  color: var(--subtle);
}
.footnote {
  margin: 0;
  padding: 0 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
</style>
