// The language of an archived text (a post's text, an account's bio), as
// `catalog.lang` stores it and the web app writes it into `lang`
// attributes: a BCP 47 tag such as `ja`, `en`, `zh-Hans`, or null when it
// cannot tell.
//
// The scripts decide first (text.ts): kana makes Japanese, Hangul Korean,
// Han characters alone Chinese (simplified or traditional by the
// characters only one of them writes, `zh` when none says) unless they
// use forms only Japanese writes. Everything else goes to fastText's
// language identification model (lid.176.ftz, 176 languages; through the
// fasttext.wasm.js binding, which ships it), whose answer counts from a
// probability of THRESHOLD. On the labelled sample (testdata/sample.json
// and docs/architecture.md, "Language") this beat CLD3 and the script
// rules alone; the threshold and minimum lengths were tuned on it.
//
// The model takes about 50 ms and 20 MB to load, and loading is
// asynchronous while catalog writes are not, so a process that writes the
// catalog loads it first (`loadLangModel`, which `openRuntime` awaits for
// the web process and the worker). Read threads never detect anything and
// never load it. Detecting without it throws rather than storing a
// language a later capture would never correct.
import {
  CJK_WEIGHT,
  cleanText,
  countScripts,
  HANGUL_WEIGHT,
  hanLang,
  modelText,
  scriptRule,
  withScript,
} from './text.ts'
import type { FastTextModel } from 'fasttext.wasm.js'

export interface Detected {
  lang: string | null
  /** The model's probability, or the share of the deciding script. */
  confidence: number
}

/** The model's answer counts from this probability. */
export const THRESHOLD = 0.4
/** Fewer letters than this (outside CJK and Hangul) say nothing. */
export const MIN_LETTERS = 4
/** Nor do CJK or Hangul text lighter than two CJK characters. */
export const MIN_CJK_WEIGHT = 2 * CJK_WEIGHT

let model: FastTextModel | undefined
let loading: Promise<void> | undefined

/** Load the model once per thread; later calls wait for the same load. */
export function loadLangModel(): Promise<void> {
  loading ??= (async () => {
    // Imported here, so read threads, which import this module through the
    // query compiler, never load the binding either.
    const { getLIDModel } = await import('fasttext.wasm.js')
    model = await (await getLIDModel()).load()
  })()
  return loading
}

export const langModelLoaded = () => model !== undefined

// The model's labels are Wikipedia's codes; the Chinese varieties it
// knows are told by script like any Chinese, and a few codes mean another
// language in ISO 639.
const LABELS: Record<string, string> = {
  yue: 'zh',
  wuu: 'zh',
  gan: 'zh',
  hak: 'zh',
  nan: 'zh',
  als: 'gsw',
}

function predict(text: string): { label: string; p: number } | undefined {
  if (!model)
    throw new Error('language model not loaded: await loadLangModel()')
  const top = model.predict(text, 1, 0)
  try {
    if (!top.size()) return undefined
    const [p, label] = top.get(0)
    return { label: label.replace('__label__', ''), p }
  } finally {
    top.delete()
  }
}

/** The language of a text; null when it is too short or unclear. */
export function detectLang(text: string | null | undefined): Detected {
  if (!model)
    throw new Error('language model not loaded: await loadLangModel()')
  const none: Detected = { lang: null, confidence: 0 }
  if (!text) return none
  const clean = cleanText(text)
  const s = countScripts(clean)
  const cjk = (s.kana + s.han) * CJK_WEIGHT
  const hangul = s.hangul * HANGUL_WEIGHT
  const total = cjk + hangul + s.other
  const rule = scriptRule(s)
  if (rule) {
    if (cjk + hangul < MIN_CJK_WEIGHT) return none
    if (rule === 'ko') return { lang: 'ko', confidence: hangul / total }
    const lang = rule === 'ja' ? 'ja' : hanLang(clean)
    return { lang, confidence: cjk / total }
  }
  if (s.other < MIN_LETTERS) return none
  // CJK and Hangul here are a minority the rules above passed over.
  const top = predict(modelText(clean, false))
  if (!top || top.p < THRESHOLD) return { lang: null, confidence: top?.p ?? 0 }
  const label = LABELS[top.label] ?? top.label
  return { lang: withScript(label, clean), confidence: top.p }
}

/** Whether `lang` is `query` or one of its variants (`zh` → `zh-Hant`). */
export const langMatches = (lang: string, query: string) =>
  lang === query || lang.startsWith(`${query}-`)
