<script setup vapor lang="ts">
import { onActivated, shallowRef } from 'vue'
import { call, client, errorText, type Watch } from '../api'
import { toast } from '../composables/useToast'
import { lastRunText, nextRunText, watchSummary, watchTitle } from '../watches'
import ConfirmSheet from './ConfirmSheet.vue'
import AppLink from './ui/AppLink.vue'
import ListSection from './ui/ListSection.vue'
import WatchSheet from './WatchSheet.vue'

// 采集 → 定期更新: every watched profile and folder.
const items = shallowRef<Watch[]>()
const error = shallowRef('')
const busy = shallowRef(false)
const editing = shallowRef<Watch>()
const removing = shallowRef<Watch>()

async function load() {
  try {
    items.value = (await call(client.watches.$get({ query: {} }))).items
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onActivated(load)
defineExpose({ load })

const targetRoute = (w: Watch) =>
  w.target === 'folder'
    ? { name: 'folder', params: { id: w.target_id } }
    : { name: 'collection', params: { id: w.target_id } }

const replace = (w: Watch) => {
  items.value = items.value?.map((item) => (item.id === w.id ? w : item))
}

async function setEnabled(w: Watch, enabled: boolean) {
  if (busy.value) return
  busy.value = true
  try {
    replace(
      await call(
        client.watches[':id'].$patch({
          param: { id: w.id },
          json: { enabled },
        }),
      ),
    )
  } catch (e) {
    toast(errorText(e))
    // The switch shows what the server has.
    items.value = [...(items.value ?? [])]
  } finally {
    busy.value = false
  }
}
async function remove() {
  const w = removing.value
  if (!w || busy.value) return
  busy.value = true
  try {
    await call(client.watches[':id'].$delete({ param: { id: w.id } }))
    items.value = items.value?.filter((item) => item.id !== w.id)
    removing.value = undefined
  } catch (e) {
    removing.value = undefined
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
function changed(w: Watch | undefined) {
  const edited = editing.value
  editing.value = undefined
  if (w) replace(w)
  else if (edited)
    items.value = items.value?.filter((item) => item.id !== edited.id)
}
const checked = (event: Event) => (event.target as HTMLInputElement).checked
</script>

<template>
  <ListSection v-if="items || error" title="定期更新">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <p v-else-if="!items?.length" class="banner empty">没有定期更新</p>
    <div v-for="w in items" :key="w.id" class="watch">
      <div class="label">
        <AppLink class="name" :to="targetRoute(w)">{{ watchTitle(w) }}</AppLink>
        <small class="hint">{{ watchSummary(w) }}</small>
        <small class="hint">{{ nextRunText(w) }}</small>
        <small v-if="w.last_run" class="hint">
          <AppLink
            class="run"
            :to="{ name: 'capture', params: { id: w.last_run.id } }"
            >{{ lastRunText(w) }}</AppLink
          >
        </small>
        <small v-if="w.error" class="hint failed"
          >上次未开始：{{ w.error }}</small
        >
      </div>
      <div class="actions">
        <input
          class="switch"
          type="checkbox"
          role="switch"
          :aria-label="`开启 ${watchTitle(w)} 的定期更新`"
          :checked="w.enabled"
          :disabled="busy"
          @change="setEnabled(w, checked($event))"
        />
        <button
          type="button"
          class="action"
          :aria-label="`编辑 ${watchTitle(w)} 的定期更新`"
          :disabled="busy"
          @click="editing = w"
        >
          编辑
        </button>
        <button
          type="button"
          class="action remove"
          :aria-label="`删除 ${watchTitle(w)} 的定期更新`"
          :disabled="busy"
          @click="removing = w"
        >
          删除
        </button>
      </div>
    </div>
  </ListSection>
  <WatchSheet
    :open="!!editing"
    :target="{
      target: editing?.target ?? 'collection',
      id: editing?.target_id ?? '',
    }"
    :label="editing && watchTitle(editing)"
    @changed="changed"
    @navigate="editing = undefined"
    @cancel="editing = undefined"
  />
  <ConfirmSheet
    :open="!!removing"
    :title="`取消 ${removing ? watchTitle(removing) : ''} 的定期更新？`"
    confirm-label="取消定期更新"
    :busy="busy"
    @confirm="remove"
    @cancel="removing = undefined"
  />
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.empty {
  color: var(--subtle);
}
.watch {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 56px;
  padding-left: var(--inset);
}
.watch + .watch::before {
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
.name {
  color: var(--text);
}
.hint {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--subtle);
}
.run {
  color: var(--link);
}
.failed {
  color: var(--destructive);
}
.actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
}
.action {
  min-height: 48px;
  padding: 0 10px;
  font-size: 15px;
  color: var(--link);
}
.action:last-child {
  padding-right: var(--inset);
}
.action:active:not(:disabled) {
  background: var(--fill);
}
.remove {
  color: var(--destructive);
}
.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 46px;
  height: 28px;
  margin: 0 4px 0 0;
  border-radius: 14px;
  background: var(--fill);
  cursor: pointer;
  transition: background 160ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 160ms ease;
}
.switch:checked {
  background: var(--link);
}
.switch:checked::after {
  transform: translateX(18px);
}
.switch:disabled {
  opacity: 0.5;
  cursor: default;
}
.switch:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
</style>
