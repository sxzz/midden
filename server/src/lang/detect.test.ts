import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { detectLang, langMatches, MIN_LETTERS, THRESHOLD } from './detect.ts'
import { cleanText, hanLang } from './text.ts'

interface Sample {
  bucket: string
  kind: 'post' | 'bio'
  /** ISO 639-1 (`zh-Hans`, `zh-Hant`, `zh` for either), `und` for none. */
  lang: string
  /** Also right for mixed text. */
  also?: string[]
  text: string
}

// Synthetic look-alikes of the archive's posts and bios (the real ones are
// other people's, so they stay out of the repository); docs/architecture.md
// ("Language") has how it was built and what the detectors scored.
const SAMPLE: Sample[] = JSON.parse(
  readFileSync(new URL('testdata/sample.json', import.meta.url), 'utf8'),
)

/** Of the sample's text with no language, how many get one anyway. */
const JUNK_WITH_LANGUAGE = 1

const base = (lang: string) => (lang.startsWith('zh') ? 'zh' : lang)

/** Whether `got` is right: by language, or `strict`ly with the script. */
function right(got: string | null, sample: Sample, strict: boolean) {
  const want = [sample.lang, ...(sample.also ?? [])]
  const g = got ?? 'und'
  return strict
    ? want.some((w) => w === g || (w === 'zh' && g.startsWith('zh')))
    : want.map(base).includes(base(g))
}

describe('detectLang', () => {
  test('on the labelled sample: as accurate as reported', () => {
    const results = SAMPLE.map((s) => ({ s, got: detectLang(s.text).lang }))
    const score = (strict: boolean) =>
      results.filter(({ s, got }) => right(got, s, strict)).length
    // 98.6% by language and 96.4% with the Chinese script, of 363.
    expect(SAMPLE).toHaveLength(363)
    expect(score(false)).toBeGreaterThanOrEqual(358)
    expect(score(true)).toBeGreaterThanOrEqual(350)
    // Text with no language in it is seldom given one.
    const junk = results.filter(({ s }) => s.lang === 'und' && !s.also)
    expect(junk.filter(({ got }) => got !== null).length).toBeLessThanOrEqual(
      JUNK_WITH_LANGUAGE,
    )
  })

  test('scripts first: kana, Hangul, Han characters by their forms', () => {
    expect(detectLang('今日は猫の日です')).toMatchObject({ lang: 'ja' })
    expect(detectLang('鏡音レン')).toMatchObject({ lang: 'ja' })
    expect(detectLang('오늘 날씨가 좋네요')).toMatchObject({ lang: 'ko' })
    expect(detectLang('今天天气很好')).toMatchObject({ lang: 'zh-Hans' })
    expect(detectLang('今天天氣很好')).toMatchObject({ lang: 'zh-Hant' })
    // Neither simplified nor traditional by any character.
    expect(detectLang('好耶')).toMatchObject({ lang: 'zh' })
    // A borrowed の or a kaomoji's ノ does not make Chinese Japanese.
    expect(detectLang('我の猫今天很可爱很可爱')).toMatchObject({
      lang: 'zh-Hans',
    })
    expect(detectLang('和老师一起去了箱根！♬(ノ゜∇゜)ノ♩')).toMatchObject({
      lang: 'zh-Hans',
    })
    // Kanji forms only Japanese writes.
    expect(hanLang('駅前広場')).toBe('ja')
    // Some English in Japanese, some Japanese in English.
    expect(detectLang('今日はReactのuseEffectでハマった')).toMatchObject({
      lang: 'ja',
    })
    expect(
      detectLang('I went to Akihabara today and bought so many things 秋葉原'),
    ).toMatchObject({ lang: 'en' })
  })

  test('the model for the rest, from its threshold', () => {
    const en = detectLang('Thank you all so much for coming tonight!!')
    expect(en.lang).toBe('en')
    expect(en.confidence).toBeGreaterThanOrEqual(THRESHOLD)
    expect(detectLang('Hoy por fin terminé el dibujo')).toMatchObject({
      lang: 'es',
    })
    expect(detectLang('Привет, как дела?')).toMatchObject({ lang: 'ru' })
    // Below the threshold: no language, with how sure the model was.
    const unsure = detectLang('new art')
    expect(unsure.lang).toBeNull()
    expect(unsure.confidence).toBeGreaterThan(0)
    expect(unsure.confidence).toBeLessThan(THRESHOLD)
  })

  test('nothing for too little text', () => {
    expect('lol'.length).toBeLessThan(MIN_LETTERS)
    for (const text of [
      '',
      null,
      'lol',
      '好',
      '안녕',
      '12:34',
      '(´・ω・｀)',
      '🎉🎉 https://a.test @alice #tag',
      '#鏡音リン #鏡音レン',
      'https://t.co/abc @bob',
    ])
      expect(detectLang(text)).toEqual({ lang: null, confidence: 0 })
  })
})

test('cleanText: no links, handles, hashtags, emoji or extra space', () => {
  expect(
    cleanText(
      '新曲🎉🎉 https://youtu.be/x  @alice mail me@a.test\n\n#ボカロ ＃日本 🇯🇵 ok',
    ),
  ).toBe('新曲 mail ok')
})

test('langMatches: a language takes its scripts', () => {
  expect(langMatches('zh-Hant', 'zh')).toBe(true)
  expect(langMatches('zh', 'zh')).toBe(true)
  expect(langMatches('zh', 'zh-Hant')).toBe(false)
  expect(langMatches('zh-Hans', 'zh-Hant')).toBe(false)
})
