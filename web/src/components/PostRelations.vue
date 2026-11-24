<script setup vapor lang="ts">
import { computed } from 'vue'
import { shortDate } from '../presentation'
import {
  authoredBy,
  authorIdentity,
  isPostEntity,
  isProfileEntity,
  type RelationAuthor,
} from '../relations'
import MediaThumbs from './MediaThumbs.vue'
import LockIcon from './ui/LockIcon.vue'
import type { Asset, Collection } from '../api'

const INSTAGRAM_SHORTCODE = /^[\w-]{1,20}$/
const INSTAGRAM_HANDLE = /^\w[\w.]{0,29}$/
const NUMERIC_ID = /^\d+$/
const X_HANDLE = /^\w{1,15}$/
/** One account seen twice: the first sighting wins, the second fills gaps. */
function fillAccount(first?: RelationAuthor, second?: RelationAuthor) {
  if (!first || !second) return first ?? second
  return {
    name: first.name ?? second.name,
    handle: first.handle ?? second.handle,
    avatar: first.avatar ?? second.avatar,
    href: first.href ?? second.href,
    protected: first.protected || second.protected,
  }
}
function openCollection(id?: string) {
  if (id) window.location.hash = `#/collection/${id}`
}
const props = defineProps<{
  collection: Collection
  compact?: boolean
  showSensitive?: boolean
  /** Show authors as the capture recorded them. */
  captured?: boolean
}>()
const relations = computed(() => {
  const graph = props.collection.graph
  if (!graph) return []
  const root = graph.entities.find((entity) => entity.key === graph.root)
  if (!isPostEntity(root)) return []
  const candidates = graph.relations.flatMap((relation) => {
    if (relation.type !== 'quoted' && relation.type !== 'reposted') return []
    const outgoing = relation.source === graph.root
    if (!outgoing && (props.compact || relation.target !== graph.root))
      return []
    const entity = graph.entities.find(
      (item) => item.key === (outgoing ? relation.target : relation.source),
    )
    // A quoted or reposted post carries its own author inside the graph.
    return entity
      ? [
          {
            type: relation.type,
            entity,
            outgoing,
            author: authorIdentity(
              authoredBy(graph, entity.key),
              props.captured,
            ),
          },
        ]
      : []
  })
  candidates.push(
    ...(props.compact ? [] : (props.collection.incoming_relations ?? [])).map(
      (relation) => ({
        ...relation,
        outgoing: false,
        // The live relation is the only place an incoming author is recorded.
        author: authorIdentity(relation.author, props.captured),
      }),
    ),
  )
  const cards = new Map<
    string,
    {
      key: string
      outgoing: boolean
      assets: Asset[]
      collectionId?: string
      label: string
      text: string
      href: string
      external: boolean
      author?: RelationAuthor
      /** A profile card's own account, shown inside its link. */
      account?: RelationAuthor
      published: string
      publishedLabel: string
    }
  >()
  for (const { type, entity, outgoing, author } of candidates) {
    const postLink = isPostEntity(entity)
    if (type !== 'quoted' && type !== 'reposted') continue
    if (
      !postLink &&
      (!isProfileEntity(entity) || outgoing || type !== 'reposted')
    )
      continue
    const externalId = entity.external_id || ''
    const handle =
      typeof entity.data.username === 'string' ? entity.data.username : ''
    const externalURL = entity.type.startsWith('instagram.')
      ? postLink &&
        typeof entity.data.shortcode === 'string' &&
        INSTAGRAM_SHORTCODE.test(entity.data.shortcode)
        ? `https://www.instagram.com/p/${entity.data.shortcode}/`
        : !postLink && INSTAGRAM_HANDLE.test(handle)
          ? `https://www.instagram.com/${handle}/`
          : ''
      : NUMERIC_ID.test(externalId)
        ? `https://x.com/i/${postLink ? 'web/status' : 'user'}/${externalId}`
        : !postLink && X_HANDLE.test(handle)
          ? `https://x.com/${handle}`
          : ''
    const href = entity.saved_collection_id
      ? `#/collection/${encodeURIComponent(entity.saved_collection_id)}`
      : externalURL
    if (!href) continue
    // A quoted or reposted post is kept by reference; its saved collection
    // says what it is, otherwise only the link remains.
    const text =
      (typeof entity.data.text === 'string' ? entity.data.text.trim() : '') ||
      entity.saved_text?.trim() ||
      entity.saved_summary?.trim() ||
      ''
    const name =
      typeof entity.data.name === 'string' ? entity.data.name.trim() : ''
    const key = `${outgoing ? 'out' : 'in'}:${type}:${entity.type}:${externalId || entity.saved_collection_id || entity.key}`
    // A profile card is its own account, so it never repeats an attribution.
    const attribution = postLink ? author : undefined
    const published =
      postLink && typeof entity.data.published_at === 'string'
        ? entity.data.published_at
        : ''
    const external = !entity.saved_collection_id
    const kind = !postLink
      ? '转发此帖的账号'
      : outgoing
        ? type === 'quoted'
          ? '↘ 引用了这条帖子'
          : '↻ 转发了这条帖子'
        : type === 'quoted'
          ? '↖ 这条帖子引用了当前帖子'
          : '↖ 这条帖子转发了当前帖子'
    const prior = cards.get(key)
    const account = postLink
      ? undefined
      : authorIdentity(entity, props.captured)
    // A live incoming relation can supply the saved link missing in an older snapshot.
    if (prior && (!prior.external || !entity.saved_collection_id)) {
      prior.author ??= attribution
      prior.account = fillAccount(prior.account, account)
      if (!prior.published && published) {
        prior.published = published
        prior.publishedLabel = shortDate(published)
      }
      continue
    }
    cards.set(key, {
      outgoing,
      assets: postLink ? entity.assets || [] : [],
      collectionId: entity.saved_collection_id,
      author: attribution ?? prior?.author,
      account: fillAccount(account, prior?.account),
      published: published || prior?.published || '',
      publishedLabel: shortDate(published) || prior?.publishedLabel || '',
      key,
      // Where the link leads belongs with its kind, not in a footer of its own.
      label: external
        ? `${kind} · 在 ${entity.type.startsWith('instagram.') ? 'Instagram' : 'X'}`
        : kind,
      text: postLink
        ? text || `帖子 ${externalId}`
        : name || (handle ? `@${handle}` : `账号 ${externalId}`),
      href,
      external,
    })
  }
  return [...cards.values()]
})
</script>

<template>
  <div
    v-if="relations.length"
    class="relations"
    :class="{ compact }"
    aria-label="帖子关联"
  >
    <div
      v-for="relation in relations"
      :key="relation.key"
      class="quote"
      :class="{ incoming: !relation.outgoing }"
    >
      <!-- The author stands beside the post link, never inside it, so a saved
           profile stays a link of its own. -->
      <div v-if="relation.author || relation.publishedLabel" class="head">
        <component
          :is="relation.author?.href ? 'a' : 'span'"
          v-if="relation.author"
          class="relation-author"
          :class="{ saved: !!relation.author.href }"
          :href="relation.author.href"
        >
          <img
            v-if="relation.author.avatar"
            class="avatar"
            :src="relation.author.avatar"
            alt=""
            loading="lazy"
          />
          <span v-if="relation.author.name" class="author-name">{{
            relation.author.name
          }}</span><LockIcon v-if="relation.author.protected" class="lock" />
          <span v-if="relation.author.handle" class="author-handle"
            >@{{ relation.author.handle }}</span
          >
        </component>
        <time
          v-if="relation.publishedLabel"
          class="published"
          :datetime="relation.published"
          >{{ relation.publishedLabel }}</time
        >
      </div>
      <a
        class="relation"
        :href="relation.href"
        :target="relation.external ? '_blank' : undefined"
        :rel="relation.external ? 'noopener noreferrer' : undefined"
      >
        <span class="label">{{ relation.label }}</span>
        <!-- The account reads like a quoted post's author row. -->
        <span v-if="relation.account" class="account">
          <img
            v-if="relation.account.avatar"
            class="avatar"
            :src="relation.account.avatar"
            alt=""
            loading="lazy"
          />
          <span v-if="relation.account.name" class="author-name">{{
            relation.account.name
          }}</span><LockIcon v-if="relation.account.protected" class="lock" />
          <span v-if="relation.account.handle" class="author-handle"
            >@{{ relation.account.handle }}</span
          >
        </span>
        <span v-else class="text">{{ relation.text }}</span>
      </a>
      <MediaThumbs
        v-if="relation.assets.length"
        :assets="relation.assets"
        :collection="{
          ...collection,
          graph: undefined,
          id: relation.collectionId || collection.id,
          text: relation.text,
          author_name: relation.author?.name || relation.author?.handle || '',
          assets: relation.assets,
        }"
        :show-sensitive="showSensitive"
        :collection-id="relation.collectionId"
        @open="openCollection(relation.collectionId)"
      />
    </div>
  </div>
</template>

<style scoped>
.relations {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}
/* A bordered card separates the referenced post from the surrounding text. */
.quote {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--separator);
  border-radius: 14px;
  background: var(--card);
}
/* Author first, the way the quoted post itself would be read. */
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.relation {
  display: grid;
  gap: 2px;
  color: inherit;
  text-decoration: none;
}
.incoming {
  border-left: 3px solid var(--link);
}
.label {
  font-weight: 600;
  color: var(--link);
  font-size: 12px;
}
.text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.5;
}
.relation-author,
.account {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: inherit;
  font-size: 13px;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.avatar {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill);
}
.author-name {
  font-weight: 600;
}
/* Tucked against the name the way X shows a protected account. */
.lock {
  flex-shrink: 0;
  margin-left: -2px;
  font-size: 13px;
}
.author-handle,
.published {
  color: var(--subtle);
  font-size: 13px;
}
.relation-author.saved .author-name {
  color: var(--link);
}
/* Only separate the date once there is an identity in front of it. */
.relation-author + .published::before {
  content: '· ';
}
.compact {
  margin-top: 8px;
}
.compact .quote {
  padding-left: 8px;
}
.compact .avatar {
  width: 16px;
  height: 16px;
}
.compact .relation-author,
.compact .author-handle,
.compact .published {
  font-size: 12px;
}
.compact .label {
  font-size: 13px;
}
/* In a list row a referenced post stays secondary to the row's own text. */
.compact .text {
  -webkit-line-clamp: 2;
  font-size: 13px;
  color: var(--subtle);
}
.relation:active,
a.relation-author:active {
  opacity: 0.6;
}
.relation:focus-visible,
a.relation-author:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
