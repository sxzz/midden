<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type ApiToken,
  type ApiTokenUsage,
} from '../api'
import { date } from '../presentation'
import { expiryText, permissionLabels } from '../tokens'
import SheetDialog from './ui/SheetDialog.vue'
import UsageBars from './UsageBars.vue'

// One token: what it is, its requests over 30 days by day and endpoint,
// and what can be done with it.
const props = defineProps<{ open: boolean; token?: ApiToken }>()
const emit = defineEmits<{
  edit: []
  roll: []
  revoke: []
  close: []
}>()
const usage = shallowRef<ApiTokenUsage>()
const error = shallowRef('')
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    usage.value = undefined
    error.value = ''
    const id = props.token?.id
    if (!id) return
    try {
      usage.value = await call(
        client.tokens[':id'].usage.$get({ param: { id } }),
      )
    } catch (e) {
      error.value = errorText(e)
    }
  },
)
</script>

<template>
  <SheetDialog
    :open="open && !!token"
    :title="token?.label ?? ''"
    cancel-label="关闭"
    @cancel="emit('close')"
  >
    <template v-if="token">
      <dl class="facts">
        <div>
          <dt>权限</dt>
          <dd>{{ permissionLabels[token.permission] }}</dd>
        </div>
        <div>
          <dt>创建于</dt>
          <dd>{{ date(token.created_at) }}</dd>
        </div>
        <div>
          <dt>过期</dt>
          <dd :class="{ expired: token.expired }">{{ expiryText(token) }}</dd>
        </div>
        <div>
          <dt>上次使用</dt>
          <dd>
            {{ token.last_used_at ? date(token.last_used_at) : '未使用' }}
          </dd>
        </div>
      </dl>
      <div class="usage">
        <p class="usage-title">最近 30 天 {{ token.usage.total }} 次</p>
        <UsageBars :days="token.usage.days" :width="300" :height="56" />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <ol v-else-if="usage?.endpoints.length" class="endpoints">
          <li v-for="e in usage.endpoints" :key="e.endpoint">
            <code>{{ e.endpoint }}</code><span>{{ e.count }}</span>
          </li>
        </ol>
      </div>
    </template>
    <template #actions>
      <button type="button" class="action" @click="emit('edit')">
        编辑名称和过期时间
      </button>
      <button type="button" class="action" @click="emit('roll')">
        轮换令牌
      </button>
      <button type="button" class="action destructive" @click="emit('revoke')">
        撤销令牌
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
.facts {
  margin: 8px 16px 0;
}
.facts div {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 15px;
}
dt {
  flex-shrink: 0;
  width: 5em;
  color: var(--subtle);
}
dd {
  margin: 0;
  min-width: 0;
}
.expired {
  color: var(--destructive);
}
.usage {
  padding: 8px 16px 0;
}
.usage-title {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--subtle);
}
.usage :deep(svg) {
  width: 100%;
  height: 56px;
}
.endpoints {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
}
.endpoints li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.endpoints code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.endpoints span {
  flex-shrink: 0;
  color: var(--subtle);
}
.error {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--destructive);
}
</style>
