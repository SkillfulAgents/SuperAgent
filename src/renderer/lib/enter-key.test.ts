// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isComposing, isSubmitEnter } from './enter-key'

const enter = (init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: 'Enter', ...init })

afterEach(() => vi.unstubAllGlobals())

describe('isSubmitEnter', () => {
  it('submits on Enter, not on Shift+Enter or the Enter that confirms an input-method candidate', () => {
    expect(isSubmitEnter(enter())).toBe(true)
    expect(isSubmitEnter(enter({ metaKey: true }))).toBe(true)
    expect(isSubmitEnter(enter({ ctrlKey: true }))).toBe(true)
    expect(isSubmitEnter(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false)
    expect(isSubmitEnter(enter({ shiftKey: true }))).toBe(false)
    expect(isSubmitEnter(enter({ isComposing: true }))).toBe(false)
    // Safari: isComposing is already false, only keyCode 229 marks it.
    expect(isSubmitEnter(enter({ keyCode: 229 }))).toBe(false)
  })

  it('leaves Enter as a newline on touch, where Cmd/Ctrl+Enter still submits', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
    expect(isSubmitEnter(enter())).toBe(false)
    expect(isSubmitEnter(enter({ metaKey: true }))).toBe(true)
    expect(isSubmitEnter(enter({ ctrlKey: true }))).toBe(true)
  })
})

describe('isComposing', () => {
  it('reads keyCode 229 as composition only on Enter', () => {
    // Android soft keyboards report 229 for keys such as Backspace outside composition.
    expect(isComposing(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 229 }))).toBe(false)
  })
})
