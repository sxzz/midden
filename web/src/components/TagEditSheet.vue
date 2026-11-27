<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
import { call, client, errorText, type Tag, type TagChange } from '../api'
import ConfirmSheet from './ConfirmSheet.vue'
import SheetDialog from './ui/SheetDialog.vue'

const props = defineProps<{
  /** The tag being edited; none closes the sheet. */
  tag?: Tag
  /** Every tag, to tell a rename from a merge before asking the server. */
  tags: Tag[]
}>()
const emit = defineEmits<{ changed: [change: TagChange]; close: [] }>()

type Step = '' | 'edit' | 'merge' | 'delete'
const step = shallowRef<Step>('')
const name = shallowRef('')
const error = shallowRef('')
const busy = shallowRef(false)
/** Collections carrying the tag, for the confirmations; unknown is none. */
const count = shallowRef(0)

watch(
  () => props.tag,
  (tag) => {
    name.value = tag?.name ?? ''
    error.value = ''
    step.value = tag ? 'edit' : ''
  },
)

const existing = (wanted: string) =>
  props.tags.find((t) => t.name === wanted && t.id !== props.tag?.id)

/** How many saved collections carry the tag: one count of the library. */
async function countTagged(id: string) {
  try {
    count.value = (
      await call(client.collections.count.$get({ query: { tag: id } }))
    ).count
  } catch {
    count.value = 0
  }
}

function close() {
  if (!busy.value) emit('close')
}
async function submit() {
  const tag = props.tag
  const wanted = name.value.trim()
  if (!tag || !wanted || busy.value) return
  if (wanted === tag.name) return close()
  if (existing(wanted)) {
    busy.value = true
    await countTagged(tag.id)
    busy.value = false
    step.value = 'merge'
    return
  }
  await rename()
}
async function askDelete() {
  const tag = props.tag
  if (!tag || busy.value) return
  busy.value = true
  await countTagged(tag.id)
  busy.value = false
  step.value = 'delete'
}
async function rename() {
  const tag = props.tag
  if (!tag) return
  busy.value = true
  error.value = ''
  try {
    const result = await call(
      client.tags[':id'].$patch({
        param: { id: tag.id },
        json: { name: name.value.trim() },
      }),
    )
    emit('changed', { from: tag.id, to: result.tag })
  } catch (e) {
    error.value = errorText(e)
    step.value = 'edit'
  } finally {
    busy.value = false
  }
}
async function remove() {
  const tag = props.tag
  if (!tag) return
  busy.value = true
  error.value = ''
  try {
    await call(client.tags[':id'].$delete({ param: { id: tag.id } }))
    emit('changed', { from: tag.id })
  } catch (e) {
    error.value = errorText(e)
    step.value = 'edit'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SheetDialog
    :open="step === 'edit'"
    title="编辑标签"
    :busy="busy"
    :dirty="name.trim() !== (tag?.name ?? '')"
    form
    @cancel="close"
    @submit="submit"
  >
    <label class="field">
      <span class="visually-hidden">标签名称</span>
      <input
        v-model="name"
        maxlength="64"
        autocomplete="off"
        enterkeyhint="done"
      />
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template #actions>
      <button
        type="submit"
        class="action primary"
        :disabled="busy || !name.trim()"
      >
        保存
      </button>
      <button
        type="button"
        class="action destructive"
        :disabled="busy"
        @click="askDelete"
      >
        删除标签
      </button>
    </template>
  </SheetDialog>
  <ConfirmSheet
    :open="step === 'merge'"
    :title="`已有标签「${name.trim()}」，将合并 ${count} 条收藏`"
    confirm-label="合并"
    :busy="busy"
    @confirm="rename"
    @cancel="step = 'edit'"
  />
  <ConfirmSheet
    :open="step === 'delete'"
    :title="`删除标签「${tag?.name ?? ''}」？`"
    :description="count ? `将从 ${count} 条收藏上移除` : undefined"
    confirm-label="删除标签"
    :busy="busy"
    @confirm="remove"
    @cancel="step = 'edit'"
  />
</template>

<style scoped>
.field {
  display: block;
  padding: 12px 16px 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
input {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  font-size: 16px;
  line-height: 1.55;
}
.error {
  margin: 0;
  padding: 12px 16px 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--destructive);
}
.action[type='submit'] {
  margin-top: 16px;
}
</style>
