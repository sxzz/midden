// The values the query language and the facet tables agree on, with no
// database: a hashtag as stored, a link's registrable domain. The web app
// reads queries with them too (`query/language.ts`).

/** At most this many characters of a value are kept. */
export const MAX_VALUE = 100

/** A hashtag as stored and asked for: compatibility forms plain, lower case. */
export const foldHashtag = (tag: string) =>
  tag.normalize('NFKC').toLowerCase().slice(0, MAX_VALUE)

/**
 * Second-level suffixes under which a name is registered one level deeper
 * (`example.co.uk`), and hosts that give each user a subdomain of their
 * own (`alice.github.io`): a short list of the common ones, after the
 * Public Suffix List, rather than all of it.
 */
const SUFFIXES = new Set(
  [
    'ac.jp ad.jp co.jp ed.jp go.jp gr.jp lg.jp ne.jp or.jp',
    'ac.uk co.uk gov.uk ltd.uk me.uk net.uk org.uk plc.uk',
    'com.cn edu.cn gov.cn net.cn org.cn com.hk edu.hk gov.hk net.hk org.hk',
    'com.tw edu.tw gov.tw idv.tw net.tw org.tw com.mo',
    'ac.kr co.kr go.kr ne.kr or.kr com.sg edu.sg gov.sg',
    'com.au edu.au gov.au net.au org.au co.nz net.nz org.nz',
    'com.br net.br org.br gov.br com.ar com.mx com.co com.pe',
    'co.in net.in org.in ac.in co.id or.id ac.id web.id co.th ac.th in.th',
    'com.my com.ph com.vn com.tr com.sa com.eg com.pk co.il org.il co.za',
    'github.io gitlab.io pages.dev workers.dev netlify.app vercel.app',
    'web.app firebaseapp.com herokuapp.com glitch.me neocities.org',
    'blogspot.com wordpress.com tumblr.com substack.com notion.site',
    'hatenablog.com hatenablog.jp hateblo.jp hatenadiary.com hatenadiary.jp',
    'fanbox.cc booth.pm itch.io carrd.co wixsite.com',
  ].flatMap((line) => line.split(' ')),
)

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const FINAL_DOT = /\.$/
const WWW = /^www\./
const SCHEME = /^[a-z][\w+.-]*:/i

/**
 * The registrable domain of a host, lower case, without `www.`:
 * `music.youtube.com` → `youtube.com`, `news.bbc.co.uk` → `bbc.co.uk`,
 * `alice.github.io` stays. Addresses stay as they are.
 */
export function registrableDomain(host: string): string {
  const lower = host.toLowerCase().replace(FINAL_DOT, '')
  if (IPV4.test(lower) || lower.includes(':')) return lower
  const labels = lower.replace(WWW, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const keep = SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** Link shorteners whose domain says nothing of where a link goes. */
const SHORTENERS = new Set(['t.co'])

/** The registrable domain of a link or a bare host; undefined if none. */
export function domainOf(raw: string): string | undefined {
  const scheme = SCHEME.test(raw)
  try {
    const url = new URL(scheme ? raw : `http://${raw}`)
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol))
      return undefined
    const domain = registrableDomain(url.hostname)
    return domain && !SHORTENERS.has(domain) ? domain : undefined
  } catch {
    return undefined
  }
}
