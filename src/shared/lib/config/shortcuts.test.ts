import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GLOBAL_DISPATCH_SHORTCUT,
  isValidAccelerator,
  codeToKey,
  eventToAccelerator,
  formatAccelerator,
  type KeyComboEvent,
} from './shortcuts'

describe('isValidAccelerator', () => {
  it('accepts the default and other real accelerators', () => {
    expect(isValidAccelerator(DEFAULT_GLOBAL_DISPATCH_SHORTCUT)).toBe(true)
    expect(isValidAccelerator('CommandOrControl+Shift+Space')).toBe(true)
    expect(isValidAccelerator('Control+Alt+K')).toBe(true)
    expect(isValidAccelerator('Command+F5')).toBe(true)
  })

  it('rejects empty, single-token, and garbage values', () => {
    expect(isValidAccelerator('')).toBe(false) // empty = "disabled", not a valid accelerator
    expect(isValidAccelerator('Space')).toBe(false) // needs modifier + key
    expect(isValidAccelerator('Command+')).toBe(false)
    expect(isValidAccelerator('+Space')).toBe(false)
    expect(isValidAccelerator('Command Shift Space')).toBe(false)
    expect(isValidAccelerator('Command+Sh!ft+Space')).toBe(false)
  })

  it('rejects absurdly long values', () => {
    expect(isValidAccelerator('A+' + 'B'.repeat(100))).toBe(false)
  })
})

describe('codeToKey', () => {
  it('maps letters, digits, and function keys', () => {
    expect(codeToKey('KeyA')).toBe('A')
    expect(codeToKey('Digit7')).toBe('7')
    expect(codeToKey('F5')).toBe('F5')
    expect(codeToKey('F24')).toBe('F24')
  })

  it('maps named keys', () => {
    expect(codeToKey('Space')).toBe('Space')
    expect(codeToKey('ArrowUp')).toBe('Up')
    expect(codeToKey('ArrowDown')).toBe('Down')
    expect(codeToKey('Enter')).toBe('Return')
  })

  it('returns null for unsupported codes', () => {
    expect(codeToKey('Comma')).toBeNull()
    expect(codeToKey('F25')).toBeNull()
    expect(codeToKey('ShiftLeft')).toBeNull()
  })
})

describe('eventToAccelerator', () => {
  const ev = (over: Partial<KeyComboEvent>): KeyComboEvent => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: 'KeyA',
    ...over,
  })

  it('builds a mac accelerator with Command for the meta key', () => {
    expect(eventToAccelerator(ev({ metaKey: true, shiftKey: true, code: 'Space' }), 'darwin')).toBe(
      'Command+Shift+Space',
    )
  })

  it('uses Super for the meta key off mac', () => {
    expect(eventToAccelerator(ev({ metaKey: true, code: 'KeyK' }), 'win32')).toBe('Super+K')
  })

  it('orders modifiers Control, Meta, Alt, Shift', () => {
    expect(
      eventToAccelerator(ev({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyJ' }), 'darwin'),
    ).toBe('Control+Alt+Shift+J')
  })

  it('returns null without a modifier or without a mappable key', () => {
    expect(eventToAccelerator(ev({ code: 'KeyA' }), 'darwin')).toBeNull() // no modifier
    expect(eventToAccelerator(ev({ metaKey: true, code: 'Comma' }), 'darwin')).toBeNull() // no key
  })
})

describe('formatAccelerator', () => {
  it('renders symbol chips on mac', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'darwin')).toBe('⌘ ⇧ Space')
    expect(formatAccelerator('Control+Alt+K', 'darwin')).toBe('⌃ ⌥ K')
  })

  it('renders +-joined tokens off mac', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl+Shift+Space')
    expect(formatAccelerator('Super+K', 'win32')).toBe('Win+K')
  })

  it('renders empty as Disabled', () => {
    expect(formatAccelerator('', 'darwin')).toBe('Disabled')
    expect(formatAccelerator('', 'win32')).toBe('Disabled')
  })
})
