import { describe, expect, it } from 'vitest'
import {
  defaultOptions,
  optionsBody,
  restoreOptions,
  scopeOf,
  withScope,
} from './capture-options'

describe('optionsBody', () => {
  it('sends a number only with 最新 or 最多', () => {
    const o = { ...defaultOptions(), posts: 'until_existing' as const }
    expect(optionsBody(o)).not.toHaveProperty('count')
    expect(optionsBody({ ...o, posts: 'none' })).not.toHaveProperty('count')
    expect(optionsBody(defaultOptions()).count).toBe(100)
    expect(optionsBody(withScope(defaultOptions(), 'max')).count).toBe(100)
  })
})

describe('restoreOptions', () => {
  it('keeps a saved scope without a number as it was', () => {
    expect(scopeOf(restoreOptions({ posts: 'max' }))).toBe('all')
    expect(restoreOptions({ posts: 'until_existing' })).not.toHaveProperty(
      'count',
    )
    expect(restoreOptions({ posts: 'latest', count: 20 }).count).toBe(20)
  })
})
