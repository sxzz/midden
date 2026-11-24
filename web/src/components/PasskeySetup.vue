<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { createPasskey, defaultPasskeyName, passkeyError } from '../passkey'
import ListSection from './ui/ListSection.vue'
// The /passkey link's token, from the address's fragment.
const props = defineProps<{ token: string }>()
const emit = defineEmits<{ done: [] }>()
const name = shallowRef(defaultPasskeyName())
const busy = shallowRef(false)
const error = shallowRef('')
async function create() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await createPasskey(name.value.trim() || defaultPasskeyName(), props.token)
    emit('done')
  } catch (e) {
    error.value = passkeyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="setup" aria-label="添加通行密钥" @submit.prevent="create">
    <h1>添加通行密钥</h1>
    <ListSection title="名称">
      <label class="field">
        <span class="visually-hidden">名称</span>
        <input v-model="name" maxlength="64" autocomplete="off" />
      </label>
      <button type="submit" class="action strong" :disabled="busy">
        创建通行密钥
      </button>
    </ListSection>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </form>
</template>

<style scoped>
.setup {
  width: 100%;
  max-width: 420px;
}
h1 {
  margin: 0 0 22px;
  text-align: center;
  font-size: 24px;
  font-weight: 700;
}
.field {
  display: block;
  padding: 12px 16px;
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
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.action:disabled {
  color: var(--subtle);
}
.action:active:not(:disabled) {
  background: var(--fill);
}
.strong {
  font-weight: 600;
}
.error {
  margin: 0;
  padding: 0 calc(var(--gutter) + 4px);
  text-align: center;
  font-size: 15px;
  line-height: 1.6;
  color: var(--destructive);
}
</style>
