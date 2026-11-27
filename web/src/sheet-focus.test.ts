import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTextField,
  lastInput,
  showSheet,
  startsOnControl,
  trackInput,
} from './sheet-focus'

beforeEach(() => {
  // jsdom has no modal dialogs; this one focuses the first control, as
  // browsers do.
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
    this.querySelector<HTMLElement>('button, input, textarea')?.focus()
  })
})
afterEach(() => document.body.replaceChildren())

function sheet(html: string) {
  const dialog = document.createElement('dialog')
  dialog.innerHTML = html
  document.body.append(dialog)
  return dialog
}
function press(pointerType: string) {
  const event = new Event('pointerdown', { bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  document.body.dispatchEvent(event)
}

describe('startsOnControl', () => {
  it('starts on the first control except after a finger or a pen', () => {
    expect(startsOnControl('keyboard')).toBe(true)
    expect(startsOnControl('mouse')).toBe(true)
    // Opened with nothing pressed yet, from the address (?dialog=accounts).
    expect(startsOnControl('')).toBe(true)
    expect(startsOnControl('touch')).toBe(false)
    expect(startsOnControl('pen')).toBe(false)
  })
})

describe('isTextField', () => {
  it('is a field to type in', () => {
    const make = (html: string) => {
      const box = document.createElement('div')
      box.innerHTML = html
      return box.firstElementChild
    }
    expect(isTextField(make('<input>'))).toBe(true)
    expect(isTextField(make('<input type="search">'))).toBe(true)
    expect(isTextField(make('<textarea></textarea>'))).toBe(true)
    // A link shown to copy is not typed in.
    expect(isTextField(make('<input readonly>'))).toBe(false)
    expect(isTextField(make('<input type="checkbox">'))).toBe(false)
    expect(isTextField(make('<button>删除</button>'))).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})

describe('showSheet', () => {
  it('holds focus itself when a finger or a pen opened it', () => {
    for (const from of ['touch', 'pen']) {
      const dialog = sheet('<button class="destructive">删除</button>')
      showSheet(dialog, from)
      expect(dialog.open).toBe(true)
      expect(document.activeElement).toBe(dialog)
      expect(dialog.getAttribute('tabindex')).toBe('-1')
      dialog.remove()
    }
  })

  it('starts on the first control from the keyboard or a mouse', () => {
    for (const from of ['keyboard', 'mouse', '']) {
      const dialog = sheet('<button>删除</button>')
      showSheet(dialog, from)
      expect(document.activeElement).toBe(dialog.querySelector('button'))
      dialog.remove()
    }
  })

  it('leaves a text field first in the sheet focused, to type in', () => {
    const dialog = sheet('<input aria-label="名称"><button>保存</button>')
    showSheet(dialog, 'touch')
    expect(document.activeElement).toBe(dialog.querySelector('input'))
  })

  it('goes by what was used last', () => {
    trackInput()
    press('touch')
    expect(lastInput()).toBe('touch')
    const touched = sheet('<button>删除</button>')
    showSheet(touched)
    expect(document.activeElement).toBe(touched)

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    expect(lastInput()).toBe('keyboard')
    const keyed = sheet('<button>删除</button>')
    showSheet(keyed)
    expect(document.activeElement).toBe(keyed.querySelector('button'))

    press('mouse')
    expect(lastInput()).toBe('mouse')
  })
})
