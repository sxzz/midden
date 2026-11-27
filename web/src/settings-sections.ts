/**
 * 设置's structure, as X lays out its settings: sections, each with a line
 * that says what it holds, and at most one more level of entries. The
 * address names them: /settings/<section>[/<entry>].
 */
export interface SettingsEntry {
  value: string
  label: string
  hint: string
  icon: 'globe' | 'disk' | 'queue' | 'backup' | 'devices' | 'users'
}
export interface SettingsSection {
  value: string
  label: string
  hint: string
  entries?: readonly SettingsEntry[]
  /** The admin's alone (`can.admin`): a viewer has no such section. */
  admin?: boolean
}

export const settingsSections: readonly SettingsSection[] = [
  { value: 'account', label: '账号', hint: '在这个Midden显示的昵称。' },
  {
    value: 'passkeys',
    label: '通行密钥',
    hint: '在浏览器中登录用的通行密钥。',
    entries: [
      {
        value: 'sessions',
        label: '已登录的设备',
        hint: '登录着的浏览器与Mini App',
        icon: 'devices',
      },
    ],
  },
  {
    value: 'tokens',
    label: 'API令牌',
    hint: '脚本与AI代理读写收藏用的令牌。',
  },
  {
    value: 'admin',
    label: '管理员面板',
    hint: '整个服务的设置。',
    admin: true,
    entries: [
      {
        value: 'users',
        label: '用户',
        hint: '查看者、邀请与备注',
        icon: 'users',
      },
      {
        value: 'origins',
        label: '域名',
        hint: '可以打开网页、用通行密钥登录的地址',
        icon: 'globe',
      },
      {
        value: 'storage',
        label: '存储用量',
        hint: '媒体、原始响应与数据库占用的空间',
        icon: 'disk',
      },
      {
        value: 'jobs',
        label: '后台任务',
        hint: '队列、暂停与限流',
        icon: 'queue',
      },
      {
        value: 'backup',
        label: '数据库备份',
        hint: 'Litestream的复制与心跳',
        icon: 'backup',
      },
    ],
  },
  { value: 'about', label: '关于', hint: '这个Midden的版本与源代码。' },
]

export function findSection(value: string) {
  return settingsSections.find((s) => s.value === value)
}

export function findEntry(section: string, value: string) {
  return findSection(section)?.entries?.find((e) => e.value === value)
}

/**
 * The sections a user has: a viewer (`admin` false) has none of the
 * admin's, and their tokens, which only read, say nothing of reading and
 * writing.
 */
export function shownSections(admin: boolean): readonly SettingsSection[] {
  if (admin) return settingsSections
  return settingsSections
    .filter((s) => !s.admin)
    .map((s) => (s.value === 'tokens' ? { ...s, hint: '' } : s))
}

/**
 * The sections and entries a search of 设置 finds, by their names and the
 * lines under them. Empty finds everything (the plain list).
 */
export function searchSettings(
  query: string,
  sections: readonly SettingsSection[] = settingsSections,
) {
  const q = query.trim().toLowerCase()
  const has = (item: { label: string; hint: string }) =>
    !q ||
    item.label.toLowerCase().includes(q) ||
    item.hint.toLowerCase().includes(q)
  return {
    sections: sections.filter(has),
    entries: q
      ? sections.flatMap((section) =>
          (section.entries ?? [])
            .filter(has)
            .map((entry) => ({ section, entry })),
        )
      : [],
  }
}

/** A text cut where it matches the query, for highlighting. */
export function splitMatch(text: string, query: string) {
  const q = query.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at === -1) return [{ text, hit: false }]
  return [
    { text: text.slice(0, at), hit: false },
    { text: text.slice(at, at + q.length), hit: true },
    { text: text.slice(at + q.length), hit: false },
  ].filter((part) => part.text)
}
