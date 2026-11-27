import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { Platforms } from './registry.ts'
import { createXPlatform } from './x/index.ts'
import { resolveTarget } from './x/resolve.ts'

test('an X profile link never resolves to a handle key: by id, or a handle to identify', () => {
  for (const url of [
    'https://x.com/VueUse',
    'https://twitter.com/vueuse/',
    'https://mobile.x.com/Some_One?lang=en',
    'https://fxtwitter.com/Fixture',
    'https://x.com/i/user/1375391728614604800',
  ]) {
    const target = resolveTarget(url)
    expect(target.externalId).not.toMatch(/^handle:/)
    expect(target.externalId || target.handle).toBeTruthy()
  }
})

test('the registry refuses a handle key from a platform that identifies handles', () => {
  const x = createXPlatform()
  const platforms = new Platforms([
    {
      ...x,
      resolve: (url) => ({ ...x.resolve(url), externalId: 'handle:vueuse' }),
    },
  ])
  expect(() => platforms.resolve('https://x.com/VueUse')).toThrow()
})

test('no X platform code makes a handle key, but for graph-only mentions', () => {
  const dir = new URL('x/', import.meta.url)
  const found = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) =>
      /[`'"]handle:/.test(readFileSync(new URL(name, dir), 'utf8')),
    )
  // A mention without an id is a graph entity only; its link is identified
  // like any other before anything is saved.
  expect(found).toEqual(['entities.ts'])
})
