// The account 关系 opens on when the address names none.

const KEY = 'midden.graphCenter'

/** Remember the account a graph was last opened on, in this browser. */
export function rememberCenter(key: string) {
  try {
    localStorage.setItem(KEY, key)
  } catch {
    // Storage can be off; 关系 then opens on the owner's account.
  }
}

export function lastCenter() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * The owner's first capture account with relation data, else the account
 * last opened, else the first with data (fetched most recently). Nothing
 * when there is no relation data at all.
 */
export function defaultCenter(
  accounts: readonly { id: string; own?: boolean }[],
  last = '',
) {
  if (!accounts.length) return ''
  return accounts.find((a) => a.own)?.id || last || accounts[0]!.id
}
