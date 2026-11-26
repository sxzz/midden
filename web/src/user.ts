/**
 * Who is signed in to this Midden: a user of the platform, not one of the
 * capture accounts (those are 采集's). There is one owner for now, so it is
 * fixed here; with several users this is where the session's user comes
 * from, and the rail (RailUser) shows whatever it returns.
 */
export interface PlatformUser {
  name: string
  /** The second line: where this user is signed in. */
  detail: string
}

export function currentUser(): PlatformUser {
  return { name: '管理员', detail: location.host }
}
