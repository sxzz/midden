<script setup vapor lang="ts">
import { computed } from "vue";
import { assetURL, type Collection } from "../api";
import { present, shortDate, warningList } from "../presentation";
import MediaGallery from "./MediaGallery.vue";
const props = defineProps<{ collection: Collection; showSensitive?: boolean }>();
const view = computed(() => present(props.collection));
const warnings = computed(() => warningList(props.collection.warnings));
</script>
<template>
  <article class="post">
    <header class="author">
      <img
        v-if="view.avatar && (!view.avatar.sensitive || showSensitive)"
        class="avatar"
        :src="assetURL(view.avatar)"
        alt=""
      /><span v-else class="avatar initials" aria-hidden="true">{{
        view.name.slice(0, 1)
      }}</span>
      <div class="identity">
        <strong class="name">{{ view.name }}</strong>
        <small class="meta"
          ><span v-if="view.handle">@{{ view.handle }} · </span
          >{{ shortDate(collection.published_at) || view.kind
          }}<span v-if="collection.visibility === 'private'"> · 私密</span></small
        >
      </div>
    </header>
    <p class="body">{{ view.body }}</p>
    <MediaGallery
      :assets="collection.assets || []"
      :show-sensitive="showSensitive"
    />
    <p v-for="warning in warnings" :key="warning" class="warning">
      {{ warning }}
    </p>
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
.meta {
  display: block;
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
</style>
