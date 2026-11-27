// Why a query cannot be run, in the app's words: by the kind the server's
// parser and compiler give (`QueryError`), with what the words need. The
// agent API keeps the English message.
import type { QueryErrorDetail, QueryErrorKind } from '@midden/server/query'

/** What a key takes, said once for the message of a bad value. */
const TAKES: Partial<Record<string, string>> = {
  from: '@用户名、x:@用户名、账号键或账号id',
  'reposted-by': '@用户名、x:@用户名、账号键或账号id',
  mentions: '@用户名或x:@用户名',
  quotes: '帖子id或@用户名',
  reposts: '帖子id或@用户名',
  rel: 'following:、followers:或mutual:加账号，如rel:following:@alice',
  related: '收藏的帖子或账号的id',
  domain: '域名，如x.com',
  lang: '语言代码，如ja、zh、en',
  platform: 'x或instagram',
  since: '日期（YYYY-MM-DD）或时刻',
  until: '日期（YYYY-MM-DD）或时刻',
  'saved-since': '日期（YYYY-MM-DD）或时刻',
  'saved-until': '日期（YYYY-MM-DD）或时刻',
  within: '天数或小时数，如30d、12h',
  saved: '日期（YYYY-MM-DD）或天数、小时数，如7d',
}

const TEXT: Record<QueryErrorKind, (d: QueryErrorDetail) => string> = {
  unopened: () => '这个 ) 前面没有 (',
  unclosed: () => '这个 ( 没有闭合',
  unclosed_quote: () => '这个 " 没有闭合',
  ends_early: () => '末尾缺少条件',
  ends_in_or: () => 'OR后面缺少条件',
  bare_minus: () => '- 后面要紧跟条件，中间不留空格',
  or_sides: () => 'OR两边都要有条件',
  empty_group: () => '括号里是空的',
  unexpected: (d) => `这里不能有 ${d.found ?? ''}`.trim(),
  no_value: (d) => `${d.key ?? ''}: 后面缺少值`,
  empty_phrase: () => '引号里是空的',
  bad_hashtag: (d) => `#${d.value ?? ''} 不是话题：只能有文字、数字和 _`,
  bad_value: (d) =>
    d.allowed
      ? `${d.key}: 只能是 ${String(d.allowed).replaceAll(', ', '、')}`
      : `${d.key}: 要写${TAKES[String(d.key)] ?? '有效的值'}`,
  no_replies: () => '收藏库不记录哪些帖子是回复，没有is:reply',
  too_many_terms: (d) => `最多${d.max}项，这里有${d.count}项`,
  value_too_long: (d) => `一个值最多${d.max}个字`,
  too_deep: (d) => `括号、OR和-最多嵌套${d.max}层`,
  too_many_alternatives: (d) => `一个OR最多${d.max}项`,
  unknown_platform: (d) => `没有平台 ${d.value}`,
  unknown_tag: (d) => `没有标签「${d.value}」`,
  unknown_folder: (d) => `没有收藏夹「${d.value}」`,
  folder_self: () => '收藏夹不能包含自己',
  folder_cycle: (d) => `收藏夹互相包含：${d.value}`,
  unknown_account: (d) => `收藏库中没有账号 ${d.value}`,
  ambiguous_account: (d) =>
    `${d.value} 对应${d.count}个账号，请写成x:@用户名或账号键`,
  only_exclusions: () =>
    '只有排除（-）的查询需要一个起点：since:、until:、within:、saved:、from:、folder:或tag:',
}

/** The error in the app's words; an unknown kind keeps the server's. */
export function queryErrorText(
  kind: string,
  detail: QueryErrorDetail = {},
  fallback = '查询无效',
): string {
  const text = TEXT[kind as QueryErrorKind]
  return text ? text(detail) : fallback
}
