<script setup vapor lang="ts">
import { onMounted, shallowRef } from 'vue'
import {
  defaultPasskeyName,
  inviteName,
  joinWithInvite,
  passkeyError,
} from '../passkey'
import ListSection from './ui/ListSection.vue'
// An invite's link (`/invite#<token>`, the token from the fragment): a
// name and a passkey make a viewer, who is then signed in.
const props = defineProps<{ token: string }>()
const emit = defineEmits<{ done: [] }>()
const name = shallowRef('')
const passkeyName = shallowRef(defaultPasskeyName())
const busy = shallowRef(true)
const error = shallowRef('')
/** The invite is no longer good: nothing to fill in. */
const gone = shallowRef(false)
onMounted(async () => {
  try {
    name.value = await inviteName(props.token)
  } catch (e) {
    error.value = passkeyError(e)
    gone.value = true
  } finally {
    busy.value = false
  }
})
async function join() {
  const chosen = name.value.trim()
  if (busy.value || !chosen) return
  busy.value = true
  error.value = ''
  try {
    await joinWithInvite(
      props.token,
      chosen,
      passkeyName.value.trim() || defaultPasskeyName(),
    )
    emit('done')
  } catch (e) {
    error.value = passkeyError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="setup" aria-label="加入Midden" @submit.prevent="join">
    <h1>加入Midden</h1>
    <ListSection v-if="!gone">
      <label class="field">
        <span class="name">名字</span>
        <input
          v-model="name"
          maxlength="32"
          autocomplete="nickname"
          :disabled="busy && !name"
        />
      </label>
      <label class="field">
        <span class="name">通行密钥名称</span>
        <input v-model="passkeyName" maxlength="64" autocomplete="off" />
      </label>
      <button
        type="submit"
        class="action strong"
        :disabled="busy || !name.trim()"
      >
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
  padding: 12px 16px 0;
}
.field:last-of-type {
  padding-bottom: 12px;
}
.name {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--subtle);
}
input {
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
