<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { passkeyError, signInWithPasskey } from '../passkey'
const emit = defineEmits<{ done: [] }>()
const busy = shallowRef(false)
const error = shallowRef('')
async function signIn() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await signInWithPasskey()
    emit('done')
  } catch (e) {
    error.value = passkeyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="login" aria-label="登录">
    <h1>Midden</h1>
    <button type="button" class="primary" :disabled="busy" @click="signIn">
      使用通行密钥登录
    </button>
    <p>首次使用请在 Telegram 中发送 /passkey</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.login {
  display: grid;
  justify-items: center;
  gap: 14px;
  width: 100%;
  max-width: 320px;
  text-align: center;
}
h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}
p {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--subtle);
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
  color: var(--destructive);
}
</style>
