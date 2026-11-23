<script setup vapor lang="ts">
import { onMounted, shallowRef, useTemplateRef } from 'vue'
import { APIError, call, client, errorText } from '../api'
const props = defineProps<{ error?: string }>()
const widget = useTemplateRef<HTMLDivElement>('widget')
const failure = shallowRef('')
onMounted(async () => {
  try {
    const { bot_username } = await call(client.auth.telegram.$get())
    const script = document.createElement('script')
    script.async = true
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.dataset.telegramLogin = bot_username
    script.dataset.size = 'large'
    script.dataset.radius = '10'
    // Redirecting back, rather than a page callback, also works where the
    // widget's popup cannot reach this window.
    script.dataset.authUrl = location.origin + location.pathname
    widget.value?.append(script)
  } catch (e) {
    // The server answers 404 when Telegram login is not configured.
    failure.value =
      e instanceof APIError && e.status === 404
        ? '服务器未配置 Telegram 登录。'
        : errorText(e)
  }
})
</script>

<template>
  <section class="login" aria-label="登录">
    <h1>Midden</h1>
    <p>使用 Telegram 账号登录</p>
    <div ref="widget" class="widget" />
    <p v-if="props.error || failure" class="error" role="alert">
      {{ props.error || failure }}
    </p>
  </section>
</template>

<style scoped>
.login {
  display: grid;
  justify-items: center;
  gap: 14px;
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
.widget {
  min-height: 40px;
}
.error {
  color: var(--destructive);
}
</style>
