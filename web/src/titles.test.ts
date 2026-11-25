import { expect, it } from 'vitest'
import {
  collectionKind,
  detailTitle,
  rememberKind,
  setDocumentTitle,
} from './titles'
import type { Collection } from './api'

const withRoot = (type: string) =>
  ({
    graph: { root: 'r', entities: [{ key: 'r', type }], relations: [] },
  }) as unknown as Collection

it('names a collection page by what it is', () => {
  expect(collectionKind(withRoot('x.profile'))).toBe('profile')
  expect(collectionKind(withRoot('instagram.profile'))).toBe('profile')
  expect(collectionKind(withRoot('x.post'))).toBe('post')
  // Shown as a post when its root is not an account.
  expect(collectionKind({ graph: undefined } as Collection)).toBe('post')
  expect(detailTitle('a', withRoot('x.post'))).toBe('帖子')
  expect(detailTitle('a', withRoot('x.profile'))).toBe('账号')
})

it('knows a page’s kind once the page has loaded it', () => {
  expect(detailTitle('loaded')).toBe('')
  rememberKind({ ...withRoot('x.profile'), id: 'loaded' })
  expect(detailTitle('loaded')).toBe('账号')
})

it('titles the browser tab after the page', () => {
  setDocumentTitle('帖子')
  expect(document.title).toBe('帖子 · Midden')
  setDocumentTitle('')
  expect(document.title).toBe('Midden')
})
