import { shallowReactive, shallowRef } from 'vue'
import { call, client, type SessionInfo } from './api'

/** What the signed-in user may do, as `GET /v1/session` says (`can`). */
export type Abilities = SessionInfo['can']
export type Role = SessionInfo['user']['role']

const ALL: Abilities = {
  capture: true,
  organize: true,
  share: true,
  delete: true,
  admin: true,
}
const NONE: Abilities = {
  capture: false,
  organize: false,
  share: false,
  delete: false,
  admin: false,
}

/**
 * What the app shows the signed-in user, by `GET /v1/session`'s `can`
 * (never by the role): a control they cannot use is not shown. The server
 * still decides every request. A development build, whose tests answer
 * the session with `{}` or 204, takes such an answer for the admin's.
 */
export const can: Readonly<Abilities> = shallowReactive({
  ...(import.meta.env.DEV ? ALL : NONE),
})
const user = shallowRef<SessionInfo['user']>()

/** Take what the server said of the session. */
export function setSession(info: Partial<SessionInfo> | undefined) {
  user.value = info?.user
  Object.assign(can, info?.can ?? (import.meta.env.DEV ? ALL : NONE))
}

/** Ask who is signed in; throws as the request does (401 when nobody). */
export async function loadSession() {
  setSession((await call(client.session.$get())) ?? undefined)
}

/** Set the signed-in user's own nickname; throws as the request does. */
export async function saveNickname(name: string) {
  setSession(await call(client.session.$patch({ json: { name } })))
}

/**
 * Who is signed in to this Midden: a user of the platform, not one of the
 * capture accounts (those are 采集's). The rail (RailUser) shows it.
 */
export interface PlatformUser {
  name: string
  /** The second line: their role, and where they are signed in. */
  detail: string
}

const ROLES: Record<Role, string> = { admin: '管理员', viewer: '查看者' }

export function currentUser(): PlatformUser {
  const role = user.value?.role ?? 'admin'
  return {
    name: user.value?.name ?? ROLES.admin,
    detail: `${ROLES[role]} · ${location.host}`,
  }
}
