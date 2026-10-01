<script setup vapor lang="ts">
import { computed } from 'vue'
import { shortDate } from '../presentation'
import { authoredBy, authorIdentity, type RelationAuthor } from '../relations'
import type { Collection } from '../api'
const props = defineProps<{ collection: Collection; compact?: boolean }>()
const relations = computed(() => {
  const graph = props.collection.graph
  if (!graph) return []
  const root = graph.entities.find((entity) => entity.key === graph.root)
  if (root?.type !== 'x.post') return []
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
            author: authorIdentity(authoredBy(graph, entity.key)),
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
        author: authorIdentity(relation.author),
      }),
    ),
  )
  const cards = new Map<
    string,
    {
      key: string
      label: string
      text: string
      href: string
      external: boolean
      author?: RelationAuthor
      published: string
      publishedLabel: string
    }
  >()
  for (const { type, entity, outgoing, author } of candidates) {
    const postLink = entity.type === 'x.post'
    if (type !== 'quoted' && type !== 'reposted') continue
    if (
      !postLink &&
      (entity.type !== 'x.profile' || outgoing || type !== 'reposted')
    )
      continue
    const externalId = entity.external_id || ''
    const handle =
      typeof entity.data.username === 'string' ? entity.data.username : ''
    const href = entity.saved_collection_id
      ? `#/collection/${encodeURIComponent(entity.saved_collection_id)}`
      : /^\d+$/.test(externalId)
        ? `https://x.com/i/${postLink ? 'web/status' : 'user'}/${externalId}`
        : !postLink && /^\w{1,15}$/.test(handle)
          ? `https://x.com/${handle}`
          : ''
    if (!href) continue
    const text =
      typeof entity.data.text === 'string' ? entity.data.text.trim() : ''
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
          ? '引用的帖子'
          : '转发的帖子'
        : type === 'quoted'
          ? '引用此帖的帖子'
          : '转发此帖的帖子'
    const prior = cards.get(key)
    // A live incoming relation can supply the saved link missing in an older snapshot.
    if (prior && (!prior.external || !entity.saved_collection_id)) {
      prior.author ??= attribution
      if (!prior.published && published) {
        prior.published = published
        prior.publishedLabel = shortDate(published)
      }
      continue
    }
    cards.set(key, {
      author: attribution ?? prior?.author,
      published: published || prior?.published || '',
      publishedLabel: shortDate(published) || prior?.publishedLabel || '',
      key,
      // Where the link leads belongs with its kind, not in a footer of its own.
      label: external ? `${kind} · 在 X` : kind,
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
    <div v-for="relation in relations" :key="relation.key" class="quote">
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
          }}</span>
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
        <span class="text">{{ relation.text }}</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.relations {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}
/* A referenced post reads as an indented aside: no card, no background, only
   the muted rule that marks where the other post begins. */
.quote {
  display: grid;
  gap: 4px;
  padding-left: 10px;
  border-left: 2px solid var(--separator);
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
.label {
  color: var(--subtle);
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
.relation-author {
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
  font-size: 11px;
}
.compact .text {
  -webkit-line-clamp: 2;
  font-size: 13px;
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
