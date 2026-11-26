<script setup vapor lang="ts">
import { computed } from 'vue'
import { safeURL, type Entity } from '../api'
import { date, present, storageSize } from '../presentation'
import { accountKey, relationQuery, type Rel } from '../relation-filter'
import {
  authoredBy,
  authorIdentity,
  authorLabel,
  isPostEntity,
  isProfileEntity,
} from '../relations'
import { collectionRoute } from '../share'
import AppLink from './ui/AppLink.vue'
import type { DetailAside } from '../aside'
// The sidebar beside a collection's page: what the page loaded, as a
// summary with links. A profile's relations and captures, a post's capture
// and the posts and accounts it links to.
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
const relationLink = (rel: Rel) => {
  const entity = root.value
  return entity && isProfileEntity(entity)
    ? { name: 'collections', query: relationQuery(accountKey(entity), rel) }
    : undefined
}
const captures = computed(() => {
  const count = props.detail.points.length
  if (!count) return ''
  return props.detail.morePoints ? `${count}+ 次` : `${count} 次`
})
const recent = computed(() => props.detail.points.slice(0, 5))
const storage = computed(() =>
  collection.value?.storage_bytes === undefined
    ? ''
    : storageSize(collection.value.storage_bytes),
)
const source = computed(() => collection.value && safeURL(collection.value.url))
const handle = computed(() =>
  collection.value ? present(collection.value).handle : '',
)
const author = computed(() => {
  const graph = collection.value?.graph
  if (!graph || profile.value) return undefined
  return authorIdentity(authoredBy(graph, graph.root))
})
const asText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : ''
/** A related post or account in one line, by its text or its name. */
function line(entity: Entity) {
  if (isPostEntity(entity)) return asText(entity.data.text) || '帖子'
  const name = asText(entity.data.name)
  const username = asText(entity.data.username)
  return [name, username && `@${username}`].filter(Boolean).join(' ') || '账号'
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
            text: line(entity),
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
            text: line(relation.entity),
          },
        ]
      : [],
  )
  return [...out, ...incoming]
})
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
      <AppLink
        v-if="detail.pages.follows"
        class="aside-more"
        :to="collectionRoute(detail.id, 'follows')"
        >关注变化</AppLink
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
        <span class="row-text">{{ authorLabel(author) }}</span>
      </component>
      <AppLink
        v-for="item in related"
        :key="item.key"
        class="row"
        :to="collectionRoute(item.id)"
      >
        <span class="row-label">{{ item.label }}</span>
        <span class="row-text">{{ item.text }}</span>
      </AppLink>
    </section>
    <section class="aside-box" aria-label="采集信息">
      <h2>采集</h2>
      <dl class="facts">
        <div v-if="profile && handle">
          <dt>账号</dt>
          <dd>@{{ handle }}</dd>
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
        <div v-if="source">
          <dt>来源</dt>
          <dd>
            <AppLink :href="source">打开原文 ↗</AppLink>
          </dd>
        </div>
      </dl>
      <ol v-if="recent.length" class="points" aria-label="最近的采集">
        <li v-for="point in recent" :key="point.capture_id">
          {{ date(point.observed_at) }}
        </li>
      </ol>
      <AppLink
        v-if="detail.record"
        class="aside-more"
        :href="`#/captures/${detail.record}`"
        >{{ detail.updating ? '更新中，查看进度' : '最近一次更新' }}</AppLink
      >
      <AppLink
        v-if="detail.pages.changes"
        class="aside-more"
        :to="collectionRoute(detail.id, 'changes')"
        >资料修改记录</AppLink
      >
      <AppLink
        v-if="detail.pages.stats"
        class="aside-more"
        :to="collectionRoute(detail.id, 'stats')"
        >统计趋势</AppLink
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
.points {
  margin: 0;
  padding: 4px 16px 8px 34px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
</style>
