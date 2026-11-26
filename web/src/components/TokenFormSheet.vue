<script setup vapor lang="ts">
import { shallowRef, useId, useTemplateRef, watch } from 'vue'
import {
  DEFAULT_EXPIRY_MS,
  expiryPresets,
  fromLocalInput,
  localInput,
  permissionLabels,
  type TokenForm,
} from '../tokens'
import type { ApiToken } from '../api'

// Making a token, or editing one: its name and expiry (a time, or never);
// a new one also gets its permission, which stays.
const props = defineProps<{
  open: boolean
  /** The token edited; making a new one without it. */
  token?: ApiToken
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ submit: [form: TokenForm]; cancel: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const label = shallowRef('')
const permission = shallowRef<ApiToken['permission']>('ro')
const expires = shallowRef('')
const never = shallowRef(false)
const problem = shallowRef('')
watch(
  () => props.open,
  (open) => {
    if (!open) {
      dialog.value?.close()
      return
    }
    const token = props.token
    label.value = token?.label ?? ''
    permission.value = token?.permission ?? 'ro'
    never.value = !!token && !token.expires_at
    expires.value = localInput(
      token?.expires_at
        ? Date.parse(token.expires_at)
        : Date.now() + DEFAULT_EXPIRY_MS,
    )
    problem.value = ''
    dialog.value?.showModal()
  },
)
function preset(ms: number) {
  never.value = false
  expires.value = localInput(Date.now() + ms)
}
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value && !props.busy) emit('cancel')
}
function submit() {
  const name = label.value.trim()
  if (!name || props.busy) return
  const at = never.value ? null : fromLocalInput(expires.value)
  if (at === undefined) {
    problem.value = '请选择过期时间'
    return
  }
  if (at !== null && Date.parse(at) <= Date.now()) {
    problem.value = '过期时间必须晚于现在'
    return
  }
  problem.value = ''
  emit('submit', { label: name, permission: permission.value, expires_at: at })
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="busy || emit('cancel')"
  >
    <form class="group" @submit.prevent="submit">
      <p :id="titleId" class="title">{{ token ? '编辑令牌' : '创建令牌' }}</p>
      <label class="field">
        <span class="name">名称</span>
        <input
          v-model="label"
          maxlength="64"
          autocomplete="off"
          placeholder="名称"
          enterkeyhint="done"
        />
      </label>
      <fieldset v-if="!token" class="field">
        <legend class="name">权限</legend>
        <div class="segments">
          <label
            v-for="(text, value) in permissionLabels"
            :key="value"
            class="segment"
            :class="{ chosen: permission === value }"
          >
            <input v-model="permission" type="radio" :value="value" />
            {{ text }}
          </label>
        </div>
      </fieldset>
      <div class="field">
        <label class="name" :for="`${titleId}-expires`">过期时间</label>
        <input
          :id="`${titleId}-expires`"
          v-model="expires"
          type="datetime-local"
          :disabled="never"
          aria-label="过期时间"
        />
        <div class="presets">
          <button
            v-for="p in expiryPresets"
            :key="p.label"
            type="button"
            class="preset"
            @click="preset(p.ms)"
          >
            {{ p.label }}
          </button>
          <label class="never">
            <input v-model="never" type="checkbox" />
            永不过期
          </label>
        </div>
      </div>
      <p v-if="problem || error" class="error" role="alert">
        {{ problem || error }}
      </p>
      <button type="submit" class="action" :disabled="busy || !label.trim()">
        {{ token ? '保存' : '创建' }}
      </button>
    </form>
    <button
      type="button"
      class="group action cancel"
      :disabled="busy"
      @click="emit('cancel')"
    >
      取消
    </button>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 480px;
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
}
.sheet:not([open]) {
  display: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.group {
  width: 100%;
  margin: 8px 0 0;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.title {
  margin: 0;
  padding: 16px 16px 4px;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
}
.field {
  display: block;
  margin: 0;
  padding: 12px 16px 0;
  border: 0;
  min-width: 0;
}
.name {
  display: block;
  float: left;
  width: 100%;
  padding: 0;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--subtle);
}
input:not([type='radio'], [type='checkbox']) {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  color: var(--text);
  font-size: 16px;
  line-height: 1.55;
}
input:disabled {
  color: var(--subtle);
}
input::placeholder {
  color: var(--subtle);
}
.segments {
  clear: both;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 12px;
  background: var(--fill);
}
.segment {
  flex: 1;
  padding: 8px 0;
  border-radius: 10px;
  text-align: center;
  font-size: 15px;
  cursor: pointer;
}
.segment.chosen {
  background: var(--card);
  font-weight: 600;
}
.segment input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.segment:has(input:focus-visible) {
  outline: 2px solid var(--link);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.preset {
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--fill);
  font-size: 14px;
  color: var(--link);
}
.never {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 15px;
}
.error {
  margin: 0;
  padding: 12px 16px 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--destructive);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  margin-top: 16px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.action:disabled {
  color: var(--subtle);
}
.cancel {
  margin-top: 8px;
  font-weight: 600;
  box-shadow: none;
}
</style>
