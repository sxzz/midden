<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { passkeyError, signInWithPasskey } from '../passkey'
import ListSection from './ui/ListSection.vue'
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
    <ListSection>
      <button
        type="button"
        class="action strong"
        :disabled="busy"
        @click="signIn"
      >
        使用通行密钥登录
      </button>
    </ListSection>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.login {
  width: 100%;
  max-width: 420px;
}
h1 {
  margin: 0 0 22px;
  text-align: center;
  font-size: 24px;
  font-weight: 700;
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
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
