<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { menuOpener, type MenuOpener } from '../action-menu'
import { call, client, errorText, type AppUser, type Invite } from '../api'
import { onShown } from '../composables/useShown'
import { toast } from '../composables/useToast'
import { shortDate } from '../presentation'
import {
  deleteEffect,
  inviteLeft,
  revokeEffect,
  roleLabels,
  waysIn,
} from '../users'
import ConfirmSheet from './ConfirmSheet.vue'
import FolderNameSheet from './FolderNameSheet.vue'
import InviteLinkSheet from './InviteLinkSheet.vue'
import ActionMenu from './ui/ActionMenu.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'

// 设置 → 管理员面板 → 用户: who may sign in, by their own nicknames with
// the admin's notes beside them, noting, revoking and deleting them, and
// invites, whose links show again until used. The admin's web session
// alone.
const users = shallowRef<AppUser[]>()
const invites = shallowRef<Invite[]>([])
const error = shallowRef('')
const busy = shallowRef(false)

async function load() {
  try {
    const [u, i] = await Promise.all([
      call(client.users.$get()),
      call(client.invites.$get()),
    ])
    users.value = u
    invites.value = i
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onShown(load)
defineExpose({ load })

/** The user whose menu is open, and how it was opened. */
const chosen = shallowRef<AppUser>()
const opener = shallowRef<MenuOpener>()
function openMenu(user: AppUser, event: MouseEvent) {
  opener.value = menuOpener(event)
  chosen.value = user
}
type Step = 'note' | 'revoke' | 'delete'
const step = shallowRef<{ step: Step; user: AppUser }>()
const stepError = shallowRef('')
function choose(value: Step) {
  const user = chosen.value
  chosen.value = undefined
  stepError.value = ''
  if (user) step.value = { step: value, user }
}

async function act(request: () => Promise<unknown>, done: string) {
  if (busy.value) return
  busy.value = true
  try {
    await request()
    step.value = undefined
    toast(done)
    await load()
  } catch (e) {
    if (step.value?.step === 'note') stepError.value = errorText(e)
    else {
      step.value = undefined
      toast(errorText(e))
    }
  } finally {
    busy.value = false
  }
}
function saveNote(note: string) {
  const user = step.value?.user
  if (!user) return
  void act(
    () =>
      call(
        client.users[':id'].$patch({ param: { id: user.id }, json: { note } }),
      ),
    '已保存备注',
  )
}
function revoke() {
  const user = step.value?.user
  if (!user) return
  void act(
    () => call(client.users[':id'].revoke.$post({ param: { id: user.id } })),
    `已撤销${user.name}`,
  )
}
function remove() {
  const user = step.value?.user
  if (!user) return
  void act(
    () => call(client.users[':id'].$delete({ param: { id: user.id } })),
    `已删除${user.name}`,
  )
}

/** Inviting: the label first, then the link. */
const inviting = shallowRef(false)
const inviteError = shallowRef('')
/** The invite whose link shows. */
const link = shallowRef<{ id: string; title: string; url: string | null }>()
const linkOf = (invite: Pick<Invite, 'id' | 'label'>, url: string | null) => ({
  id: invite.id,
  title: `邀请${invite.label}`,
  url,
})
function invite() {
  inviteError.value = ''
  inviting.value = true
}
async function createInvite(label: string) {
  if (busy.value) return
  busy.value = true
  try {
    const made = await call(client.invites.$post({ json: { label } }))
    inviting.value = false
    link.value = linkOf(made.invite, made.url)
    await load()
  } catch (e) {
    inviteError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
/** Making a link again, once confirmed: the old one stops working. */
const regenerating = shallowRef<{ id: string; title: string }>()
function askRegenerate() {
  const shown = link.value
  link.value = undefined
  if (shown) regenerating.value = shown
}
async function regenerate() {
  const pending = regenerating.value
  if (!pending || busy.value) return
  busy.value = true
  try {
    const made = await call(
      client.invites[':id'].regenerate.$post({ param: { id: pending.id } }),
    )
    regenerating.value = undefined
    link.value = linkOf(made.invite, made.url)
    await load()
  } catch (e) {
    regenerating.value = undefined
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
const revokingInvite = shallowRef<Invite>()
async function revokeInvite() {
  const pending = revokingInvite.value
  if (!pending || busy.value) return
  busy.value = true
  try {
    await call(client.invites[':id'].$delete({ param: { id: pending.id } }))
    toast('已撤销邀请')
    await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    revokingInvite.value = undefined
    busy.value = false
  }
}
</script>

<template>
  <SkeletonRows v-if="!users && !error" :rows="2" hint label="正在读取用户" />
  <ListSection v-if="users || error">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <component
      :is="u.role === 'admin' ? 'div' : 'button'"
      v-for="u in users"
      :key="u.id"
      :type="u.role === 'admin' ? undefined : 'button'"
      class="user"
      :class="{ revoked: u.revoked_at }"
      :aria-haspopup="u.role === 'admin' ? undefined : 'menu'"
      @click="u.role === 'admin' ? undefined : openMenu(u, $event)"
    >
      <span class="label"
        >{{ u.name }}<span v-if="u.note" class="note">{{ u.note }}</span
        ><span class="badge">{{
          u.revoked_at ? '已撤销' : roleLabels[u.role]
        }}</span
        ><small class="hint"
          >加入于{{ shortDate(u.created_at) }} · {{ waysIn(u) }}</small
        ></span
      >
    </component>
    <ListButton v-if="users" label="邀请" :disabled="busy" @select="invite" />
  </ListSection>
  <ListSection v-if="invites.length" title="邀请">
    <div v-for="i in invites" :key="i.id" class="invite">
      <button
        type="button"
        class="open"
        aria-haspopup="dialog"
        @click="link = linkOf(i, i.url)"
      >
        <span class="label"
          >{{ i.label }}<small class="hint">{{ inviteLeft(i) }}</small></span
        >
      </button>
      <button
        type="button"
        class="revoke"
        :aria-label="`撤销邀请${i.label}`"
        :disabled="busy"
        @click="revokingInvite = i"
      >
        撤销
      </button>
    </div>
  </ListSection>
  <ActionMenu
    v-slot="{ item }"
    :open="!!chosen"
    :opener="opener"
    :label="chosen?.name ?? ''"
    @cancel="chosen = undefined"
  >
    <button type="button" class="action" v-bind="item" @click="choose('note')">
      备注
    </button>
    <button
      v-if="!chosen?.revoked_at"
      type="button"
      class="action destructive"
      v-bind="item"
      @click="choose('revoke')"
    >
      撤销
    </button>
    <button
      type="button"
      class="action destructive"
      v-bind="item"
      @click="choose('delete')"
    >
      删除
    </button>
  </ActionMenu>
  <FolderNameSheet
    :open="step?.step === 'note'"
    title="备注"
    confirm-label="保存"
    label="备注"
    placeholder="备注"
    :maxlength="32"
    :name="step?.user.note ?? ''"
    optional
    :busy="busy"
    :error="stepError"
    @submit="saveNote"
    @cancel="step = undefined"
  />
  <ConfirmSheet
    :open="step?.step === 'revoke'"
    :title="`撤销${step?.user.name ?? ''}？`"
    :description="step ? revokeEffect(step.user) : undefined"
    confirm-label="撤销"
    :busy="busy"
    @confirm="revoke"
    @cancel="step = undefined"
  />
  <ConfirmSheet
    :open="step?.step === 'delete'"
    :title="`删除${step?.user.name ?? ''}？`"
    :description="step ? deleteEffect(step.user) : undefined"
    confirm-label="删除"
    :busy="busy"
    @confirm="remove"
    @cancel="step = undefined"
  />
  <FolderNameSheet
    :open="inviting"
    title="邀请"
    confirm-label="生成链接"
    label="备注"
    placeholder="备注"
    :maxlength="32"
    :busy="busy"
    :error="inviteError"
    @submit="createInvite"
    @cancel="inviting = false"
  />
  <InviteLinkSheet
    :open="!!link"
    :title="link?.title ?? ''"
    :url="link?.url ?? null"
    @done="link = undefined"
    @regenerate="askRegenerate"
  />
  <ConfirmSheet
    :open="!!regenerating"
    title="重新生成链接？"
    description="原链接立即失效。"
    confirm-label="重新生成"
    :busy="busy"
    @confirm="regenerate"
    @cancel="regenerating = undefined"
  />
  <ConfirmSheet
    :open="!!revokingInvite"
    :title="`撤销邀请${revokingInvite?.label ?? ''}？`"
    description="链接立即失效。"
    confirm-label="撤销邀请"
    :busy="busy"
    @confirm="revokeInvite"
    @cancel="revokingInvite = undefined"
  />
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.user,
.invite {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 56px;
  padding-left: var(--inset);
  text-align: left;
  color: var(--text);
}
button.user {
  padding-right: var(--inset);
}
button.user:active {
  background: var(--fill);
}
.user + .user::before,
.user + :deep(.row)::before,
.invite + .invite::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.user.revoked .label {
  color: var(--subtle);
}
.label {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}
.open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-self: stretch;
  align-items: center;
  text-align: left;
  color: var(--text);
}
.open:active {
  background: var(--fill);
}
.note {
  margin-left: 6px;
  font-size: 14px;
  color: var(--subtle);
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
.revoke {
  flex: none;
  min-height: 44px;
  padding: 0 var(--inset);
  font-size: 15px;
  color: var(--destructive);
}
.revoke:disabled {
  color: var(--subtle);
}
</style>
