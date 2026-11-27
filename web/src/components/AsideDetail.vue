<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { call, client, type CaptureRecord, type Entity } from '../api'
import { recordCounts, recordProgress } from '../captures'
import { date, present, storageSize } from '../presentation'
import { accountKey, relationQuery, type Rel } from '../relation-filter'
import {
  authoredBy,
  authorIdentity,
  authorLabel,
  isPostEntity,
  isProfileEntity,
} from '../relations'
import { collectionRoute, shareSlug } from '../share'
import AppLink from './ui/AppLink.vue'
import TightText from './ui/TightText.vue'
import type { DetailAside } from '../aside'
// The sidebar beside a collection's page: what the page loaded, as a
// summary with links, and for the owner the update (the page's own sheets
// open from here). A profile's relations, a post's author and the posts
// and accounts it links to, the captures, then its 历史.
const props = defineProps<{ detail: DetailAside }>()
const collection = computed(() => props.detail.collection)
const root = computed(() =>
  collection.value?.graph?.entities.find(
    (entity) => entity.key === collection.value?.graph?.root,
  ),
)
const profile = computed(() => isProfileEntity(root.value))
const followRows = [
  { rel: 'following', label: '关注' },
  { rel: 'followers', label: '粉丝' },
  { rel: 'mutual', label: '互关' },
] as const
// Behind a public link the counts stay plain numbers and the owner's update
// records stay out, as on the page itself.
const shared = computed(() => !!shareSlug.value)
const actions = computed(() =>
  shared.value ? undefined : props.detail.actions,
)
const relationLink = (rel: Rel) => {
  const entity = root.value
  return !shared.value && entity && isProfileEntity(entity)
    ? { name: 'collections', query: relationQuery(accountKey(entity), rel) }
    : undefined
}
const captures = computed(() => {
  const count = props.detail.points.length
  if (!count) return ''
  return props.detail.morePoints ? `${count}+次` : `${count}次`
})
/** The record's own facts, which the card leaves to the sidebar. */
const facts = computed(() =>
  collection.value ? present(collection.value).details : [],
)
const fact = (key: string) => facts.value.find((f) => f.key === key)
const storage = computed(() =>
  collection.value?.storage_bytes === undefined
    ? ''
    : storageSize(collection.value.storage_bytes),
)
const author = computed(() => {
  const graph = collection.value?.graph
  if (!graph || profile.value) return undefined
  return authorIdentity(authoredBy(graph, graph.root))
})
const asText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : ''
/**
 * A related post or account in one line. A post reads as its author and its
 * text: its own, or, kept by reference, its saved copy's (`saved_text`);
 * without any text, what it holds (图片帖子, 视频帖子). An account reads as
 * its name and handle.
 */
function line(entity: Entity, author?: ReturnType<typeof authorIdentity>) {
  if (isPostEntity(entity)) {
    const who = author?.name || (author?.handle ? `@${author.handle}` : '')
    const text =
      asText(entity.data.text) ||
      asText(entity.saved_text) ||
      asText(entity.saved_summary)
    if (text) return who ? `${who}：${text}` : text
    const kinds = new Set(entity.assets?.map((asset) => asset.kind))
    const held = kinds.has('video')
      ? '视频帖子'
      : kinds.has('image')
        ? '图片帖子'
        : '没有文字的帖子'
    return who ? `${who}的${held}` : held
  }
  const name = asText(entity.data.name)
  const username = asText(entity.data.username)
  return [name, username && `@${username}`].filter(Boolean).join(' ') || '账号'
}
/** The line's language: its saved collection's, unless the line is ours. */
function lineLang(entity: Entity) {
  const own = isPostEntity(entity)
    ? asText(entity.data.text)
    : asText(entity.data.name) || asText(entity.data.username)
  return own ? entity.saved_lang : undefined
}
const labels: Record<string, string> = {
  quoted: '引用',
  reposted: '转发',
}
/** The saved posts and accounts this one quotes or reposts, or is quoted by. */
const related = computed(() => {
  const value = collection.value
  const graph = value?.graph
  if (!value || !graph || profile.value) return []
  const out = graph.relations.flatMap((relation) => {
    if (relation.source !== graph.root || !labels[relation.type]) return []
    const entity = graph.entities.find((item) => item.key === relation.target)
    return entity?.saved_collection_id
      ? [
          {
            key: `out:${relation.type}:${entity.key}`,
            label: labels[relation.type]!,
            id: entity.saved_collection_id,
            text: line(entity, authorIdentity(authoredBy(graph, entity.key))),
            lang: lineLang(entity),
          },
        ]
      : []
  })
  const incoming = (value.incoming_relations ?? []).flatMap((relation) =>
    relation.entity.saved_collection_id
      ? [
          {
            key: `in:${relation.type}:${relation.entity.key}`,
            label: relation.type === 'reposted' ? '转发了它' : '引用了它',
            id: relation.entity.saved_collection_id,
            text: line(
              relation.entity,
              authorIdentity(relation.entity.saved_author),
            ),
            lang: lineLang(relation.entity),
          },
        ]
      : [],
  )
  return [...out, ...incoming]
})

/**
 * The running update's record, read every few seconds for its progress
 * while it runs; the page itself only knows that it runs.
 */
const running = shallowRef<CaptureRecord>()
let timer: ReturnType<typeof setTimeout> | undefined
let reading = 0
async function follow() {
  clearTimeout(timer)
  const n = ++reading
  const id =
    actions.value && props.detail.updating ? props.detail.record : undefined
  if (!id) {
    running.value = undefined
    return
  }
  if (running.value?.id !== id) running.value = undefined
  try {
    const found = await call(client.captures[':id'].$get({ param: { id } }))
    if (n === reading) running.value = found
  } catch {
    // The bar waits for the next reading; the link still leads to it.
  }
  if (n === reading && !running.value?.done) timer = setTimeout(follow, 3000)
}
watch(
  () => [props.detail.record, props.detail.updating, !!actions.value],
  follow,
  { immediate: true },
)
onUnmounted(() => {
  ++reading
  clearTimeout(timer)
})
const progress = computed(() =>
  running.value ? recordProgress(running.value) : undefined,
)
const progressText = computed(() =>
  running.value ? recordCounts(running.value) : '',
)
</script>

<template>
  <template v-if="collection">
    <section
      v-if="profile && detail.follows"
      class="aside-box"
      aria-label="关系网"
    >
      <h2>关系网</h2>
      <div class="follows">
        <component
          :is="relationLink(row.rel) ? AppLink : 'span'"
          v-for="row in followRows"
          :key="row.rel"
          class="follow"
          :to="relationLink(row.rel)"
        >
          <strong>{{
            (detail.follows?.[row.rel] ?? 0).toLocaleString('zh-CN')
          }}</strong>
          <span>{{ row.label }}</span>
        </component>
      </div>
      <AppLink class="aside-more" :to="collectionRoute(detail.id, 'graph')"
        >关系图谱</AppLink
      >
    </section>
    <section v-if="!profile && author" class="aside-box" aria-label="相关">
      <h2>相关</h2>
      <component
        :is="author.href ? AppLink : 'span'"
        class="row"
        :href="author.href"
      >
        <span class="row-label">作者</span>
        <span class="row-text" :lang="author.lang">{{
          authorLabel(author)
        }}</span>
      </component>
      <AppLink
        v-for="item in related"
        :key="item.key"
        class="row"
        :to="collectionRoute(item.id)"
      >
        <span class="row-label">{{ item.label }}</span>
        <span class="row-text" :lang="item.lang"
          ><TightText :text="item.text"
        /></span>
      </AppLink>
    </section>
    <section class="aside-box" aria-label="采集信息">
      <h2>采集</h2>
      <!-- The owner's update: the button, then how far the running one is. -->
      <div v-if="actions" class="update">
        <button
          type="button"
          class="update-button"
          :disabled="actions.disabled || detail.updating"
          @click="actions.update()"
        >
          {{ detail.updating ? '正在更新…' : '更新' }}
        </button>
        <template v-if="detail.updating">
          <progress
            class="aside-progress"
            :value="progress"
            max="1"
            aria-label="更新进度"
          />
          <p v-if="progressText" class="update-counts">{{ progressText }}</p>
        </template>
      </div>
      <AppLink
        v-if="detail.record && actions"
        class="aside-more"
        :to="{ name: 'capture', params: { id: detail.record } }"
        >{{ detail.updating ? '查看进度' : '最近一次更新' }}</AppLink
      >
      <dl class="facts">
        <div
          v-for="key in ['published', 'edited']"
          v-show="fact(key)"
          :key="key"
        >
          <dt>{{ fact(key)?.label }}</dt>
          <dd>
            <time :datetime="fact(key)?.datetime">{{ fact(key)?.value }}</time>
          </dd>
        </div>
        <div v-if="detail.savedAt">
          <dt>保存于</dt>
          <dd>{{ date(detail.savedAt) }}</dd>
        </div>
        <div v-if="captures">
          <dt>采集次数</dt>
          <dd>{{ captures }}</dd>
        </div>
        <div v-if="storage">
          <dt>占用空间</dt>
          <dd>{{ storage }}</dd>
        </div>
        <!-- The owner edits it here; behind a share it is not shown. -->
        <div v-if="profile && actions?.editWatch" class="editable">
          <dt>定期更新</dt>
          <dd>
            <button
              type="button"
              class="edit"
              aria-label="编辑定期更新"
              @click="actions.editWatch()"
            >
              <span class="edit-text"
                >{{ detail.watch?.label ?? '未开启'
                }}<template v-if="detail.watch?.hint">
                  · {{ detail.watch.hint }}</template
                ></span
              ><span class="edit-chevron" aria-hidden="true">›</span>
            </button>
          </dd>
        </div>
        <div v-else-if="profile && detail.watch">
          <dt>定期更新</dt>
          <dd>
            {{ detail.watch.label
            }}<template v-if="detail.watch.hint">
              · {{ detail.watch.hint }}</template
            >
          </dd>
        </div>
        <div v-if="detail.exposure && actions">
          <dt>公开</dt>
          <dd :title="detail.exposure">{{ detail.exposure }}</dd>
        </div>
        <div
          v-for="key in ['uid', 'uuid']"
          v-show="fact(key)"
          :key="key"
          class="identifier"
        >
          <dt>{{ fact(key)?.label }}</dt>
          <dd :title="fact(key)?.value">{{ fact(key)?.value }}</dd>
        </div>
      </dl>
      <!-- Behind a share the latest update stays the owner's. -->
      <AppLink
        v-if="detail.record && !actions && !shared"
        class="aside-more"
        :to="{ name: 'capture', params: { id: detail.record } }"
        >{{ detail.updating ? '更新中，查看进度' : '最近一次更新' }}</AppLink
      >
    </section>
    <!-- One entry, no heading: an account's 资料, 数据 and 关注 are the tabs
         of its 历史; a post has its 统计趋势. -->
    <section
      v-if="detail.history"
      class="aside-box history"
      :aria-label="profile ? '历史' : '统计趋势'"
    >
      <AppLink
        class="aside-row"
        :to="collectionRoute(detail.id, detail.history)"
        ><span class="aside-row-name">{{ profile ? '历史' : '统计趋势' }}</span
        ><span class="aside-row-count" aria-hidden="true">›</span></AppLink
      >
    </section>
  </template>
</template>

<style scoped>
.follows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 4px 8px 8px;
}
.follow {
  display: grid;
  justify-items: start;
  padding: 8px;
  border-radius: 10px;
  color: var(--text);
}
a.follow:hover {
  background: var(--fill);
}
.follow strong {
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.follow span {
  font-size: 13px;
  color: var(--subtle);
}
.row {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.45;
}
a.row:hover {
  background: var(--fill);
}
.row-label {
  flex: none;
  color: var(--subtle);
}
.row-text {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.update {
  padding: 4px 16px 8px;
}
/* The sidebar's one filled button, as X's 关注. */
.update-button {
  width: 100%;
  min-height: 36px;
  border-radius: 999px;
  background: var(--primary-fill);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  text-align: center;
}
.update-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary-fill) 88%, #000);
}
.update-counts {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.facts {
  margin: 0;
  padding: 0 16px 8px;
  font-size: 14px;
}
.facts div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}
.facts dt {
  flex: none;
  color: var(--subtle);
}
.facts dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* 定期更新: the whole row opens its sheet. */
.facts .editable {
  position: relative;
  margin: 0 -8px;
  padding: 5px 8px;
  border-radius: 8px;
}
.facts .editable:hover {
  background: var(--fill);
}
/* The row is the control's shape, so the ring goes round it rather than
   round the words (whose cell would clip it). */
.facts .editable:has(.edit:focus-visible) {
  outline: 2px solid var(--link);
  outline-offset: 0;
}
.edit:focus-visible {
  outline: none;
}
.edit {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  color: var(--link);
}
/* The row is the button's target. */
.edit::after {
  content: '';
  position: absolute;
  inset: 0;
}
.edit-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-chevron {
  flex: none;
  color: var(--subtle);
}
.history {
  padding: 4px 0;
}
.identifier dd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
