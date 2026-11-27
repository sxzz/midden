<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { call, client, errorText, type ApiToken } from '../api'
import { onShown } from '../composables/useShown'
import { toast } from '../composables/useToast'
import { shortDate } from '../presentation'
import { expiryText, permissionLabels, type TokenForm } from '../tokens'
import ConfirmSheet from './ConfirmSheet.vue'
import TokenDetailSheet from './TokenDetailSheet.vue'
import TokenFormSheet from './TokenFormSheet.vue'
import TokenSecretSheet from './TokenSecretSheet.vue'
import AppLink from './ui/AppLink.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'
import UsageBars from './UsageBars.vue'
/** Under a heading of its own (设置's section), without its title. */
defineProps<{ bare?: boolean }>()

// 设置 → API 令牌: tokens for scripts and AI agents. Only a signed-in owner
// manages them; a token itself cannot.
const items = shallowRef<ApiToken[]>()
const error = shallowRef('')
const busy = shallowRef(false)
/** The form: open to make a token, or to edit `editing`. */
const form = shallowRef(false)
const editing = shallowRef<ApiToken>()
const formError = shallowRef('')
const shown = shallowRef<ApiToken>()
const confirming = shallowRef<{ action: 'roll' | 'revoke'; token: ApiToken }>()
const secret = shallowRef<{ title: string; value: string }>()
const doc = `${location.origin}/agent.md`

async function load() {
  try {
    items.value = await call(client.tokens.$get())
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onShown(load)
defineExpose({ load })

const lastUsed = (t: ApiToken) =>
  t.last_used_at ? `上次使用 ${shortDate(t.last_used_at)}` : '未使用'

function create() {
  editing.value = undefined
  formError.value = ''
  form.value = true
}
function edit() {
  editing.value = shown.value
  shown.value = undefined
  formError.value = ''
  form.value = true
}
async function submit(input: TokenForm) {
  if (busy.value) return
  busy.value = true
  try {
    const token = editing.value
    if (token) {
      await call(
        client.tokens[':id'].$patch({
          param: { id: token.id },
          json: { label: input.label, expires_at: input.expires_at },
        }),
      )
    } else {
      const made = await call(client.tokens.$post({ json: input }))
      secret.value = { title: `已创建 ${made.token.label}`, value: made.secret }
    }
    form.value = false
    await load()
  } catch (e) {
    formError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
function ask(action: 'roll' | 'revoke') {
  const token = shown.value
  shown.value = undefined
  if (token) confirming.value = { action, token }
}
async function confirm() {
  const pending = confirming.value
  if (!pending || busy.value) return
  busy.value = true
  try {
    const param = { id: pending.token.id }
    if (pending.action === 'roll') {
      const rolled = await call(client.tokens[':id'].roll.$post({ param }))
      secret.value = {
        title: `已轮换 ${rolled.token.label}`,
        value: rolled.secret,
      }
    } else {
      await call(client.tokens[':id'].$delete({ param }))
      toast(`已撤销 ${pending.token.label}`)
    }
    confirming.value = undefined
    await load()
  } catch (e) {
    confirming.value = undefined
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SkeletonRows
    v-if="!items && !error"
    :title="!bare"
    :rows="2"
    hint
    label="正在读取 API 令牌"
  />
  <ListSection v-if="items || error" :title="bare ? undefined : 'API 令牌'">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <button
      v-for="t in items"
      :key="t.id"
      type="button"
      class="token"
      :aria-label="`${t.label}，${permissionLabels[t.permission]}`"
      @click="shown = t"
    >
      <span class="label"
        >{{ t.label
        }}<span class="badge">{{ permissionLabels[t.permission] }}</span
        ><small class="hint" :class="{ expired: t.expired }">{{
          expiryText(t)
        }}</small
        ><small class="hint"
          >创建于 {{ shortDate(t.created_at) }} · {{ lastUsed(t) }}</small
        ></span
      >
      <span class="usage">
        <UsageBars :days="t.usage.days" :width="60" :height="18" />
        <small>30 天 {{ t.usage.total }} 次</small>
      </span>
    </button>
    <ListButton
      v-if="items"
      label="创建令牌"
      :disabled="busy"
      @select="create"
    />
  </ListSection>
  <p v-if="items" class="doc">
    给 AI agent 的说明：<AppLink :href="doc">{{ doc }}</AppLink>
  </p>
  <TokenFormSheet
    :open="form"
    :token="editing"
    :busy="busy"
    :error="formError"
    @submit="submit"
    @cancel="form = false"
  />
  <TokenDetailSheet
    :open="!!shown"
    :token="shown"
    @edit="edit"
    @roll="ask('roll')"
    @revoke="ask('revoke')"
    @close="shown = undefined"
  />
  <ConfirmSheet
    :open="!!confirming"
    :title="`${confirming?.action === 'roll' ? '轮换' : '撤销'} ${confirming?.token.label ?? ''}？`"
    :description="
      confirming?.action === 'roll'
        ? '旧令牌立即失效，新令牌只显示一次。'
        : '令牌立即失效。'
    "
    :confirm-label="confirming?.action === 'roll' ? '轮换令牌' : '撤销令牌'"
    :busy="busy"
    @confirm="confirm"
    @cancel="confirming = undefined"
  />
  <TokenSecretSheet
    :open="!!secret"
    :title="secret?.title ?? ''"
    :secret="secret?.value ?? ''"
    @done="secret = undefined"
  />
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.token {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 56px;
  padding: 0 var(--inset);
  text-align: left;
  color: var(--text);
}
.token:active {
  background: var(--fill);
}
.token + .token::before,
.token + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.label {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}
.badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--fill);
  font-size: 12px;
  color: var(--subtle);
  vertical-align: 2px;
}
.hint {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--subtle);
}
.hint.expired {
  color: var(--destructive);
}
.usage {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  flex-shrink: 0;
}
.usage small {
  font-size: 12px;
  color: var(--subtle);
  white-space: nowrap;
}
.doc {
  margin: -14px 0 22px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.doc :deep(a) {
  color: var(--link);
}
</style>
