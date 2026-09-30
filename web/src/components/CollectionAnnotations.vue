<script setup vapor lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { api, errorText, type Annotation, type Tag } from '../api'
import ListSection from './ui/ListSection.vue'
import TagChips from './ui/TagChips.vue'
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ saved: [] }>()
/** Matches the server's note limit; the counter appears near it. */
const noteLimit = 10000
const note = shallowRef('')
const selected = ref<string[]>([])
const tags = ref<Tag[]>([])
const name = shallowRef('')
const loading = shallowRef(true)
const busy = shallowRef(false)
const error = shallowRef('')
const ready = shallowRef(false)
const tagKey = (ids: string[]) => JSON.stringify([...ids].sort())
/** What the server last confirmed. Saving is only offered against a real
    difference, so an untouched collection cannot be written back. */
const stored = shallowRef({ note: '', tags: '' })
const dirty = computed(
  () =>
    ready.value &&
    (note.value !== stored.value.note ||
      tagKey(selected.value) !== stored.value.tags),
)
const field = useTemplateRef<HTMLTextAreaElement>('noteField')
/** Grow the note with its content, so reading it back never means scrolling
    a four-line box. CSS keeps both a floor and a ceiling. */
function grow() {
  const el = field.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
// `post` so the field is mounted and holds its new text before it is measured.
watch([ready, note], grow, { flush: 'post' })
let generation = 0
async function load() {
  const current = ++generation
  loading.value = true
  ready.value = false
  error.value = ''
  try {
    const [annotation, available] = await Promise.all([
      api<Annotation>(
        `/collections/${encodeURIComponent(props.id)}/annotation`,
      ),
      api<Tag[]>('/tags'),
    ])
    if (current !== generation) return
    name.value = ''
    note.value = annotation.note
    selected.value = annotation.tags.map((tag) => tag.id)
    tags.value = available
    stored.value = { note: note.value, tags: tagKey(selected.value) }
    ready.value = true
  } catch (e) {
    if (current === generation) error.value = errorText(e)
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(() => props.id, load, { immediate: true })
function createTag() {
  const wanted = name.value.trim()
  if (busy.value || !wanted) return
  const tag = tags.value.find((item) => item.name === wanted) ?? {
    id: `draft:${wanted}`,
    name: wanted,
  }
  if (!tags.value.some((item) => item.id === tag.id)) tags.value.push(tag)
  if (!selected.value.includes(tag.id)) selected.value.push(tag.id)
  name.value = ''
}
async function save() {
  if (busy.value || !dirty.value) return
  busy.value = true
  error.value = ''
  const current = generation
  const sent = {
    note: note.value,
    tags: tags.value
      .filter((tag) => selected.value.includes(tag.id))
      .map((tag) => tag.name),
  }
  try {
    const annotation = await api<Annotation>(
      `/collections/${encodeURIComponent(props.id)}/annotation`,
      {
        method: 'PATCH',
        body: JSON.stringify({ note: sent.note, tag_names: sent.tags }),
      },
    )
    if (current !== generation) return
    selected.value = annotation.tags.map((tag) => tag.id)
    tags.value = annotation.tags
    stored.value = { note: sent.note, tags: tagKey(selected.value) }
    // Reload available tags after the server removed unused ones.
    const available = await api<Tag[]>('/tags').catch(() => annotation.tags)
    if (current !== generation) return
    tags.value = available
    emit('saved')
  } catch (e) {
    if (current === generation) error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ListSection
    title="我的整理"
    footnote="备注和标签仅当前账号可见，适用于这条收藏的所有版本。"
  >
    <form class="annotations" @submit.prevent="save">
      <div
        v-if="loading"
        class="placeholder"
        role="status"
        aria-label="正在加载备注和标签"
        aria-busy="true"
      >
        <span class="skeleton note-block" aria-hidden="true" />
        <span class="pills" aria-hidden="true">
          <span class="skeleton pill" /><span class="skeleton pill wide" /><span
            class="skeleton pill"
        /></span>
      </div>
      <div v-else-if="!ready" class="failed">
        <p class="message bad" role="alert">{{ error }}</p>
        <button type="button" class="retry" @click="load">重试</button>
      </div>
      <fieldset v-else class="fields" :disabled="busy">
        <div class="field">
          <label class="field-label" :for="`note-${id}`">备注</label>
          <textarea
            :id="`note-${id}`"
            ref="noteField"
            v-model="note"
            rows="3"
            :maxlength="noteLimit"
            placeholder="记下你为什么保存它…"
          />
          <p v-if="note.length > noteLimit - 500" class="hint">
            {{ note.length }} / {{ noteLimit }}
          </p>
        </div>
        <div class="field">
          <span class="field-label">标签</span>
          <TagChips
            v-if="tags.length"
            v-model="selected"
            label="选择标签"
            :tags="tags"
            multiple
          />
          <p v-else class="hint">还没有标签，在下面创建第一个。</p>
          <div class="create">
            <svg
              class="plus"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M12 5.5v13M5.5 12h13" />
            </svg>
            <input
              v-model="name"
              class="create-field"
              aria-label="新标签名称"
              placeholder="新标签名称"
              maxlength="64"
              @keydown.enter.prevent="createTag"
            /><button
              type="button"
              class="create-action"
              :disabled="!name.trim()"
              @click="createTag"
            >
              创建
            </button>
          </div>
        </div>
        <p v-if="error" class="message bad" role="alert">{{ error }}</p>
        <button type="submit" class="save" :disabled="!dirty">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </fieldset>
    </form>
  </ListSection>
</template>

<style scoped>
.fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
/* Note and tags are two stacked rows of one card, parted by the same inset
   hairline the rest of the app's grouped lists use. */
.field {
  position: relative;
  padding: 13px var(--inset) 16px;
}
.field + .field::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.field-label {
  display: block;
  margin-bottom: 9px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
textarea {
  display: block;
  width: 100%;
  min-height: 82px;
  /* The note grows with its text; beyond half a screen it scrolls instead of
     pushing the tags and the save action out of reach. */
  max-height: 55vh;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  color: inherit;
  font: inherit;
  line-height: 1.55;
  resize: none;
  overflow-y: auto;
}
textarea::placeholder {
  color: var(--subtle);
}
.hint {
  margin: 8px 0 0;
  color: var(--subtle);
  font-size: 13px;
  line-height: 1.5;
}
/* Creating a tag shares the chips' pill shape, so it reads as the next tag
   rather than a separate form. */
.create {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  padding: 0 4px 0 12px;
  border-radius: 999px;
  background: var(--fill);
}
.plus {
  flex: none;
  width: 17px;
  height: 17px;
  color: var(--subtle);
}
.create-field {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  border: 0;
  /* No border or fill of its own; the radius only shapes the focus ring, which
     is pulled inward so it cannot spill past the pill. */
  border-radius: 999px;
  background: none;
  font: inherit;
  outline-offset: -2px;
}
.create-field::placeholder {
  color: var(--subtle);
}
.create-action {
  flex: none;
  min-height: 40px;
  padding: 0 10px;
  color: var(--link);
  font-size: 15px;
  font-weight: 500;
}
.create-action:disabled {
  color: var(--subtle);
  opacity: 1;
}
/* The commit action spans the card, and its hairline runs full width to mark
   the break between what you are editing and what applies it. */
.save {
  position: relative;
  display: block;
  width: 100%;
  min-height: 50px;
  padding: 13px var(--inset);
  color: var(--link);
  font-size: 16px;
  font-weight: 600;
  text-align: center;
}
.save::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: var(--separator);
}
.save:disabled {
  color: var(--subtle);
  opacity: 1;
}
.save:active:not(:disabled) {
  background: var(--fill);
}
.save:focus-visible {
  outline-offset: -3px;
}
.failed {
  padding-top: 16px;
}
.retry {
  min-height: 44px;
  padding: 0 var(--inset) 12px;
  color: var(--link);
  font-size: 15px;
}
.message {
  margin: 0;
  padding: 0 var(--inset) 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.message.bad {
  color: var(--destructive);
}
.placeholder {
  padding: 16px var(--inset);
}
.note-block {
  display: block;
  height: 82px;
  border-radius: 12px;
}
.pills {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}
.pill {
  width: 74px;
  height: 34px;
  border-radius: 999px;
}
.pill.wide {
  width: 108px;
}
</style>
