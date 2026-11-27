<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { call, client, errorText, type Share } from '../api'
import { toast } from '../composables/useToast'
import { shareURL } from '../share'
import SheetDialog from './ui/SheetDialog.vue'
const props = defineProps<{
  open: boolean
  target: 'folder' | 'collection'
  id: string
  title: string
}>()
const emit = defineEmits<{ changed: []; cancel: [] }>()
const slugId = useId()
const slugHintId = useId()
const field = useTemplateRef<HTMLInputElement>('field')
const share = shallowRef<Share>()
const loading = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const link = computed(() => (share.value ? shareURL(share.value.slug) : ''))
// A custom slug: lowercase letters, digits and inner dashes, as the server
// checks; a random one never has this form. Anyone can guess a custom slug,
// so random stays the default.
const CUSTOM = /^[a-z\d][a-z\d-]{1,62}[a-z\d]$/
const custom = computed(() => !!share.value && CUSTOM.test(share.value.slug))
const OTHER_CHARS = /[^a-z\d-]/
const draft = shallowRef('')
const slugError = shallowRef('')
watch(share, (value) => {
  draft.value = value && CUSTOM.test(value.slug) ? value.slug : ''
  slugError.value = ''
})
/** What is wrong with the slug being typed, before it is sent. */
const problem = computed(() => {
  const value = draft.value
  if (!value) return ''
  if (OTHER_CHARS.test(value)) return '只能用小写字母、数字和 -'
  if (value.length < 3) return '至少 3 个字符'
  if (value.length > 64) return '最多 64 个字符'
  if (value.startsWith('-') || value.endsWith('-')) return '不能以 - 开头或结尾'
  return ''
})
const savable = computed(
  () =>
    !!draft.value &&
    !problem.value &&
    draft.value !== share.value?.slug &&
    !busy.value,
)
/** Give the link another slug, or a random one again; the old one stops. */
async function setSlug(slug: string | null) {
  const current = share.value
  if (!current) return
  busy.value = true
  slugError.value = ''
  try {
    share.value = await call(
      client.shares[':id'].$patch({
        param: { id: current.id },
        json: { slug },
      }),
    )
    toast(slug ? '已更新链接' : '已改回随机链接')
    emit('changed')
  } catch (e) {
    slugError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function load() {
  loading.value = true
  error.value = ''
  share.value = undefined
  try {
    const all = await call(client.shares.$get({ query: {} }))
    share.value = all.find(
      (s) => s.target === props.target && s.target_id === props.id,
    )
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) void load()
  },
)
async function create() {
  busy.value = true
  error.value = ''
  try {
    share.value = await call(
      client.shares.$post({ json: { target: props.target, id: props.id } }),
    )
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function revoke() {
  const current = share.value
  if (!current) return
  busy.value = true
  error.value = ''
  try {
    await call(client.shares[':id'].$delete({ param: { id: current.id } }))
    share.value = undefined
    toast('已取消公开')
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    toast('已复制链接')
  } catch {
    // Some web views refuse the clipboard; leave the link selected instead.
    field.value?.select()
    toast('请手动复制链接')
  }
}
/** A custom link typed and not saved yet. */
const dirty = computed(
  () => draft.value !== (custom.value ? share.value!.slug : ''),
)
</script>

<template>
  <SheetDialog
    :open="open"
    :title="title"
    description="任何拿到链接的人都能查看，无需登录。"
    :busy="busy"
    :dirty="dirty"
    cancel-label="完成"
    wide
    @cancel="emit('cancel')"
  >
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="share">
      <div class="field">
        <input
          ref="field"
          :value="link"
          aria-label="公开链接"
          readonly
          @focus="($event.target as HTMLInputElement).select()"
        />
      </div>
      <form class="field custom" @submit.prevent="savable && setSlug(draft)">
        <label class="label" :for="slugId">自定义链接</label>
        <span class="slug"
          ><span class="prefix" aria-hidden="true">/s/</span
          ><input
            :id="slugId"
            v-model.trim="draft"
            :placeholder="custom ? '' : '例如 my-picks'"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            maxlength="80"
            :aria-invalid="!!(problem || slugError)"
            :aria-describedby="slugHintId"
          /><button type="submit" class="save" :disabled="!savable">
            保存
          </button></span
        >
        <span
          :id="slugHintId"
          class="hint"
          :class="{ invalid: problem || slugError }"
          :role="problem || slugError ? 'alert' : undefined"
          >{{
            problem ||
            slugError ||
            '小写字母、数字和 -，3 到 64 个字符；改动后旧链接立即失效。'
          }}</span
        >
      </form>
    </template>
    <template #actions>
      <template v-if="share">
        <button
          type="button"
          class="action primary"
          :disabled="busy"
          @click="copy"
        >
          复制链接
        </button>
        <button
          v-if="custom"
          type="button"
          class="action"
          :disabled="busy"
          @click="setSlug(null)"
        >
          改回随机链接
        </button>
        <button
          type="button"
          class="action destructive"
          :disabled="busy"
          @click="revoke"
        >
          取消公开
        </button>
      </template>
      <button
        v-else
        type="button"
        class="action primary"
        :disabled="busy || loading"
        @click="create"
      >
        创建公开链接
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
.field {
  display: block;
  padding: 0 16px 16px;
}
.field input {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: var(--fill);
  font-size: 14px;
  color: var(--text);
  text-overflow: ellipsis;
}
.custom {
  display: grid;
  gap: 6px;
}
.label {
  font-size: 13px;
  color: var(--subtle);
}
.slug {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 12px;
  border-radius: 10px;
  background: var(--fill);
}
.prefix {
  font-size: 14px;
  color: var(--subtle);
}
.field .slug input {
  flex: 1;
  min-width: 0;
  padding-left: 0;
  background: none;
}
.save {
  padding: 0 14px;
  min-height: 40px;
  font-size: 15px;
  color: var(--link);
}
.save:disabled {
  color: var(--subtle);
}
.hint {
  font-size: 13px;
  line-height: 1.4;
  color: var(--subtle);
}
.hint.invalid {
  color: var(--destructive);
}
.error {
  margin: 0;
  padding: 0 16px 12px;
  font-size: 14px;
  line-height: 1.5;
  text-align: center;
  color: var(--destructive);
}
</style>
