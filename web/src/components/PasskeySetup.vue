<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { createPasskey, defaultPasskeyName, passkeyError } from '../passkey'
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
    <label class="field">
      <span>名称</span>
      <input v-model="name" maxlength="64" autocomplete="off" />
    </label>
    <button type="submit" class="primary" :disabled="busy">创建通行密钥</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </form>
</template>

<style scoped>
.setup {
  display: grid;
  gap: 14px;
  width: 100%;
  max-width: 320px;
}
h1 {
  margin: 0 0 4px;
  text-align: center;
  font-size: 24px;
  font-weight: 700;
}
.field {
  display: grid;
  gap: 6px;
  font-size: 13px;
  color: var(--subtle);
}
input {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--card);
  font-size: 16px;
  line-height: 1.55;
  color: var(--text);
}
.primary {
  width: 100%;
  min-height: 48px;
  border-radius: 12px;
  background: var(--link);
  font-size: 17px;
  font-weight: 600;
  color: #fff;
}
.primary:disabled {
  opacity: 0.6;
}
.error {
  margin: 0;
  text-align: center;
  font-size: 15px;
  line-height: 1.6;
  color: var(--destructive);
}
</style>
