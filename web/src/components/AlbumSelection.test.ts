import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp, nextTick, shallowRef } from 'vue'
import { asset, collection } from '../testing/api'
import CollectionAlbum from './CollectionAlbum.vue'
vi.mock('vue-router', async () => {
  const { resolve } = await import('../testing/router')
  return { useRouter: () => ({ push: vi.fn(), resolve }) }
})
const items = [
  collection({
    id: 'first',
    assets: [
      asset({ id: 'one', mime: 'image/png' }),
      asset({ id: 'two', mime: 'image/png', sensitive: true }),
    ],
  }),
  collection({
    id: 'second',
    assets: [asset({ id: 'three', mime: 'image/png', sensitive: true })],
  }),
]
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
})
function mount(initial?: string[]) {
  const toggled: string[] = []
  const selected = shallowRef(initial)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CollectionAlbum, {
    items: () => items,
    mediaTypes: () => '',
    loading: () => false,
    next: () => '',
    error: () => '',
    selected: () => selected.value,
    // Toggles the way CollectionView does, so the album shows what it chose.
    onToggle: () => (id: string) => {
      toggled.push(id)
      if (!selected.value) return
      selected.value = selected.value.includes(id)
        ? selected.value.filter((item) => item !== id)
        : [...selected.value, id]
    },
  })
  app.mount(el)
  unmount = () => app.unmount()
  return { el, toggled }
}
const tiles = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>('.tile'),
]

it('tiles toggle their post while the album is selecting', async () => {
  const { el, toggled } = mount([])
  expect(tiles(el).map((tile) => tile.getAttribute('role'))).toEqual([
    'checkbox',
    'checkbox',
    'checkbox',
  ])
  expect(el.querySelectorAll('.check')).toHaveLength(3)
  tiles(el)[0]!.click()
  await nextTick()
  // Every tile of the post shows it, the sensitive one too.
  expect(toggled).toEqual(['first'])
  expect(tiles(el).map((tile) => tile.getAttribute('aria-checked'))).toEqual([
    'true',
    'true',
    'false',
  ])
  expect(el.querySelectorAll('.selected .check svg')).toHaveLength(2)
  // A blurred tile is chosen, not revealed, and nothing opens.
  tiles(el)[2]!.click()
  await nextTick()
  expect(toggled).toEqual(['first', 'second'])
  expect(tiles(el)[2]!.classList.contains('blurred')).toBe(true)
  expect(tiles(el)[2]!.getAttribute('aria-checked')).toBe('true')
  tiles(el)[1]!.click()
  await nextTick()
  expect(tiles(el).map((tile) => tile.getAttribute('aria-checked'))).toEqual([
    'false',
    'false',
    'true',
  ])
  expect(document.querySelector('dialog')).toBeNull()
})

it('tiles open or reveal as before when the album is not selecting', async () => {
  const { el, toggled } = mount()
  expect(tiles(el)[0]!.getAttribute('role')).toBeNull()
  expect(tiles(el)[0]!.hasAttribute('aria-checked')).toBe(false)
  expect(el.querySelector('.check')).toBeNull()
  tiles(el)[2]!.click()
  await nextTick()
  expect(toggled).toEqual([])
  expect(tiles(el)[2]!.classList.contains('blurred')).toBe(false)
})
