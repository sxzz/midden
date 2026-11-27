// 设置 → 管理员面板 → 用户: how a user and an invite read.
import { remaining } from './tokens'
import type { AppUser, Invite } from './api'

export const roleLabels: Record<AppUser['role'], string> = {
  admin: '管理员',
  viewer: '查看者',
}

/** The ways in a user has, each counted: 2个通行密钥、3个登录、1个令牌. */
export function waysIn(
  user: Pick<AppUser, 'passkeys' | 'sessions' | 'tokens'>,
) {
  return `${user.passkeys}个通行密钥、${user.sessions}个登录、${user.tokens}个令牌`
}

/** What 撤销 does to a user, said before it is done. */
export function revokeEffect(user: AppUser) {
  return `将删除${waysIn(user)}，立即退出，用户保留为已撤销。`
}

/** What 删除 does to a user, said before it is done. */
export function deleteEffect(user: AppUser) {
  return `将删除这个用户和${waysIn(user)}。`
}

/** How long an invite is still good: 剩6天23小时. */
export function inviteLeft(
  invite: Pick<Invite, 'expires_at'>,
  now = Date.now(),
) {
  const left = remaining(invite.expires_at, now)
  return left === '已过期' ? left : `剩${left}`
}
