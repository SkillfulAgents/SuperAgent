// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isTypingTarget, usePlainKeys } from './todo-shortcuts'

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('isTypingTarget', () => {
  it('treats text fields and editable content as typing', () => {
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(editable)).toBe(true)
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('usePlainKeys', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('hands plain keys to the handler and consumes the ones it uses', () => {
    const handler = vi.fn((e: KeyboardEvent) => e.key === 'c')
    renderHook(() => usePlainKeys(handler))
    expect(press('c').defaultPrevented).toBe(true)
    expect(press('x').defaultPrevented).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('ignores keys with ⌘, Ctrl or Alt, so app shortcuts pass through', () => {
    const handler = vi.fn(() => true)
    renderHook(() => usePlainKeys(handler))
    press('k', { metaKey: true })
    press('b', { ctrlKey: true })
    press('d', { altKey: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores keys typed into a field', () => {
    const handler = vi.fn(() => true)
    renderHook(() => usePlainKeys(handler))
    const input = document.createElement('input')
    document.body.appendChild(input)
    press('j', {}, input)
    expect(handler).not.toHaveBeenCalled()
  })

  it('stays quiet while disabled, as when a dialog is open', () => {
    const handler = vi.fn(() => true)
    renderHook(() => usePlainKeys(handler, false))
    press('c')
    expect(handler).not.toHaveBeenCalled()
  })
})
