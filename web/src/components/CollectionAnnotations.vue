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
const error = shallowRef('')
const ready = shallowRef(false)
/** The note is committed by hand and the tags save themselves, so each side
    carries its own progress, failure and confirmed baseline. Neither request
    may report for the other, and neither answer may overwrite the other's
    editing state. */
const noteSaving = shallowRef(false)
const noteError = shallowRef('')
const storedNote = shallowRef('')
const tagsSaving = shallowRef(false)
const tagsError = shallowRef('')
/** Keyed by tag *name*, the only identity both sides agree on: a tag created
    here carries a local draft id until the server answers with a real one. */
const storedTags = shallowRef('')
const tagKey = (names: string[]) => JSON.stringify([...names].sort())
const chosen = () =>
  tags.value
    .filter((tag) => selected.value.includes(tag.id))
    .map((tag) => tag.name)
const noteDirty = computed(() => ready.value && note.value !== storedNote.value)
const tagsDirty = computed(
  () => ready.value && tagKey(chosen()) !== storedTags.value,
)
const url = computed(
  () => `/collections/${encodeURIComponent(props.id)}/annotation`,
)
const noteStatus = computed(() => {
  if (noteSaving.value) return '正在保存备注…'
  if (note.value.length > noteLimit - 500)
    return `${note.value.length} / ${noteLimit}`
  return noteDirty.value ? '备注尚未保存' : ''
})
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
/** Latest tag edit still to be written, and whether a writer is draining it. */
let tagsQueued = false
let tagsWriting = false
async function load() {
  const current = ++generation
  loading.value = true
  ready.value = false
  error.value = ''
  noteSaving.value = false
  noteError.value = ''
  tagsSaving.value = false
  tagsError.value = ''
  // Another collection's queued edit must not be written against this one.
  tagsQueued = false
  tagsWriting = false
  try {
    const [annotation, available] = await Promise.all([
      api<Annotation>(url.value),
      api<Tag[]>('/tags'),
    ])
    if (current !== generation) return
    name.value = ''
    note.value = annotation.note
    selected.value = annotation.tags.map((tag) => tag.id)
    tags.value = available
    storedNote.value = note.value
    storedTags.value = tagKey(annotation.tags.map((tag) => tag.name))
    ready.value = true
  } catch (e) {
    if (current === generation) error.value = errorText(e)
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(() => props.id, load, { immediate: true })
function editTags(ids: string[]) {
  selected.value = ids
  queueTags()
}
function createTag() {
  const wanted = name.value.trim()
  if (!ready.value || !wanted) return
  const tag = tags.value.find((item) => item.name === wanted) ?? {
    id: `draft:${wanted}`,
    name: wanted,
  }
  if (!tags.value.some((item) => item.id === tag.id)) tags.value.push(tag)
  if (!selected.value.includes(tag.id)) selected.value.push(tag.id)
  name.value = ''
  queueTags()
}
/** Record that the chips differ from the server and make sure exactly one
    writer is draining them: a burst of edits stays in order, and only the last
    one has to reach the server. */
function queueTags() {
  if (!ready.value) return
  tagsQueued = true
  if (tagsWriting) return
  tagsWriting = true
  void writeTags()
}
async function writeTags() {
  const current = generation
  try {
    while (tagsQueued && current === generation) {
      tagsQueued = false
      if (tagKey(chosen()) === storedTags.value) break
      tagsSaving.value = true
      tagsError.value = ''
      try {
        const annotation = await api<Annotation>(url.value, {
          method: 'PATCH',
          body: JSON.stringify({ tag_names: chosen() }),
        })
        if (current !== generation) return
        // Record what the server now holds even when a newer edit is already
        // waiting: otherwise the next pass could read this write's own result
        // as the baseline and skip the write that puts the chips back.
        storedTags.value = tagKey(annotation.tags.map((tag) => tag.name))
        // A newer edit already replaced what this request sent; leave the chips
        // alone so its own write decides, instead of flashing back to this one.
        if (tagsQueued) continue
        // The note keeps whatever is in the box: this answer is not about it.
        selected.value = annotation.tags.map((tag) => tag.id)
        tags.value = annotation.tags
        // Reload available tags after the server removed unused ones.
        const available = await api<Tag[]>('/tags').catch(() => annotation.tags)
        if (current !== generation) return
        if (!tagsQueued) tags.value = available
        emit('saved')
      } catch (e) {
        if (current !== generation) return
        // Only report a failure that is still what the chips ask for; a newer
        // edit supersedes it, so keep draining rather than stopping here.
        if (tagsQueued) continue
        tagsError.value = errorText(e)
        return
      }
    }
  } finally {
    if (current === generation) {
      tagsWriting = false
      tagsSaving.value = false
    }
  }
}
async function saveNote() {
  if (noteSaving.value || !noteDirty.value) return
  const current = generation
  noteSaving.value = true
  noteError.value = ''
  const sent = note.value
  try {
    const annotation = await api<Annotation>(url.value, {
      method: 'PATCH',
      body: JSON.stringify({ note: sent }),
    })
    if (current !== generation) return
    // Confirm the note only. The chips may have been edited or written while
    // this was in flight, and this answer's tags can already be stale.
    storedNote.value = annotation.note
    emit('saved')
  } catch (e) {
    if (current === generation) noteError.value = errorText(e)
  } finally {
    if (current === generation) noteSaving.value = false
  }
}
</script>

<template>
  <ListSection
    title="我的整理"
    footnote="备注和标签仅当前账号可见，适用于这条收藏的所有版本。"
  >
    <form class="annotations" @submit.prevent="saveNote">
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
      <div v-else class="fields">
        <section class="field">
          <label class="field-label" :for="`note-${id}`">备注</label>
          <textarea
            :id="`note-${id}`"
            ref="noteField"
            v-model="note"
            rows="3"
            :maxlength="noteLimit"
            placeholder="记下你为什么保存它…"
          />
          <div class="note-actions">
            <p class="hint" role="status">{{ noteStatus }}</p>
            <button
              type="submit"
              class="commit"
              :disabled="!noteDirty || noteSaving"
            >
              保存备注
            </button>
          </div>
          <p v-if="noteError" class="message bad" role="alert">
            {{ noteError }}
          </p>
        </section>
        <section class="field">
          <span class="field-label">标签</span>
          <TagChips
            v-if="tags.length"
            :model-value="selected"
            label="选择标签"
            :tags="tags"
            multiple
            @update:model-value="editTags"
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
          <p v-if="tagsSaving" class="hint" role="status">正在保存标签…</p>
          <p v-if="tagsError" class="message bad" role="alert">
            {{ tagsError }}
          </p>
          <button
            v-if="tagsError && tagsDirty"
            type="button"
            class="retry"
            @click="queueTags"
          >
            重试保存标签
          </button>
        </section>
      </div>
    </form>
  </ListSection>
</template>

<style scoped>
.fields {
  min-width: 0;
}
/* Note and tags are two stacked rows of one card, parted by the same inset
   hairline the rest of the app's grouped lists use. Each row carries its own
   action or autosave notice, so it is clear which one a message belongs to. */
.field {
  position: relative;
  display: block;
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
  margin: 10px 0 0;
  color: var(--subtle);
  font-size: 13px;
  line-height: 1.5;
}
/* The note's own row: what it is waiting for on the left, the only action that
   writes it on the right. Nothing here speaks for the tags. */
.note-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.note-actions .hint {
  flex: 1;
  min-width: 0;
  margin: 0;
}
.commit {
  flex: none;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--link) 14%, transparent);
  color: var(--link);
  font-size: 14px;
  font-weight: 600;
  transition: transform 0.12s ease;
}
.commit:disabled {
  background: var(--fill);
  color: var(--subtle);
  opacity: 1;
}
.commit:active:not(:disabled) {
  transform: scale(0.97);
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
.failed {
  padding: 16px var(--inset) 14px;
}
.failed .message {
  margin: 0;
}
.retry {
  min-height: 44px;
  margin-top: 4px;
  color: var(--link);
  font-size: 15px;
  font-weight: 500;
}
.message {
  margin: 10px 0 0;
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
