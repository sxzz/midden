import { HANS } from './hans.ts'

/**
 * How library search reads text. Whatever is indexed and whatever is asked
 * for goes through `fold` first: compatibility forms (full-width letters and
 * digits, half-width katakana) to their plain ones, lower case, traditional
 * Chinese to simplified, invisible characters out and any run of white space
 * to one space. Folding twice changes nothing.
 *
 * Two FTS5 tables index the catalog's folded search columns by its rowid.
 * `catalog_fts` uses the trigram tokenizer, so it finds any substring of
 * three or more characters. One or two CJK characters are a word but too
 * few for a trigram, so `catalog_cjk` holds, per column, the distinct CJK
 * characters and pairs of adjacent ones as words of their own (`cjkWords`).
 * Keeping them apart from the trigrams costs about a fifth of what writing
 * them into the trigram columns would, since they need no positions.
 */

const HAN = /\p{sc=Han}/gu
const INVISIBLE = /\p{Cf}+/gu
const SPACE = /[\p{Cc}\s]+/gu
const AT = /^@/

/** Text as search compares it; empty for nothing. */
export function fold(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(HAN, (c) => HANS.get(c) ?? c)
    .replaceAll(INVISIBLE, '')
    .replaceAll(SPACE, ' ')
    .trim()
}

/** Scripts written without spaces, where two characters make a word. */
const CJK_CHAR = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}ー`
const CJK_RUN = new RegExp(`[${CJK_CHAR}]+`, 'gu')
const CJK_WORD = new RegExp(`^[${CJK_CHAR}]{1,2}$`, 'u')

/**
 * The distinct CJK characters in folded text and the pairs of adjacent
 * ones, as words.
 */
export function cjkWords(folded: string | null | undefined): string {
  if (!folded) return ''
  const words = new Set<string>()
  for (const [run] of folded.matchAll(CJK_RUN)) {
    const chars = [...run]
    for (let i = 0; i < chars.length; i++) {
      words.add(chars[i]!)
      if (i + 1 < chars.length) words.add(chars[i]! + chars[i + 1]!)
    }
  }
  return [...words].join(' ')
}

/**
 * The stored names of an account: its display name and `@handle`, folded,
 * one per line. Either may be missing.
 */
export function searchName(
  name: string | null | undefined,
  handle: string | null | undefined,
): string {
  const lines = [fold(name)]
  const h = fold(handle).replace(AT, '')
  if (h) lines.push(`@${h}`)
  return lines.join('\n')
}

const runes = (text: string) => [...text].length

/** An FTS5 string: double quotes doubled. */
const quote = (text: string) => `"${text.replaceAll('"', '""')}"`

const isCjkWord = (term: string) => CJK_WORD.test(term)

/** Share of a query's units a fuzzy match must hold. */
export const FUZZY_RATIO = 0.5

/** A search query as the indexes answer it. */
export interface SearchQuery {
  /** The whole query, folded. */
  folded: string
  /** Its distinct space-separated terms. */
  terms: string[]
  /** `catalog_fts` expression for the terms of three or more characters. */
  trigrams?: string
  /** `catalog_cjk` expression for the terms of one or two CJK characters. */
  words?: string
  /** Terms neither index holds, matched against the stored columns. */
  short: string[]
  /**
   * Tier 4: the distinct trigrams and CJK pairs of the query, and how many
   * of them must match.
   */
  fuzzy?: { trigrams: string[]; pairs: string[]; min: number }
}

/** Undefined when the query is empty once folded. */
export function parseSearch(q: string): SearchQuery | undefined {
  const folded = fold(q)
  if (!folded) return undefined
  const terms = [...new Set(folded.split(' '))]
  const long = terms.filter((term) => runes(term) >= 3)
  const words = terms.filter((term) => isCjkWord(term))
  // A single character says too little to be partly right about.
  const pairs = words.filter((term) => runes(term) === 2)
  const short = terms.filter((term) => runes(term) < 3 && !isCjkWord(term))
  const trigrams = [
    ...new Set(
      long.flatMap((term) => {
        const chars = [...term]
        return chars.slice(2).map((_, i) => chars.slice(i, i + 3).join(''))
      }),
    ),
  ]
  const units = trigrams.length + pairs.length
  return {
    folded,
    terms,
    ...(long.length ? { trigrams: long.map(quote).join(' AND ') } : {}),
    ...(words.length ? { words: words.map(quote).join(' AND ') } : {}),
    short,
    // Fewer than three units leave nothing to be partly right about.
    ...(units >= 3
      ? {
          fuzzy: {
            trigrams,
            pairs,
            min: Math.max(2, Math.ceil(units * FUZZY_RATIO)),
          },
        }
      : {}),
  }
}
