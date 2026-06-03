// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTextSelection } from './use-text-selection'

function createContainerWithText() {
  const container = document.createElement('div')
  container.textContent = 'Hello world this is some text to select'
  document.body.appendChild(container)
  return container
}

function mockSelection(container: HTMLElement, text: string) {
  const range = document.createRange()
  const textNode = container.firstChild!
  range.setStart(textNode, 0)
  range.setEnd(textNode, text.length)

  const rect = new DOMRect(100, 200, 50, 16)
  range.getClientRects = () => [rect] as unknown as DOMRectList
  range.getBoundingClientRect = () => rect

  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)

  vi.spyOn(selection, 'toString').mockReturnValue(text)
  vi.spyOn(selection, 'isCollapsed', 'get').mockReturnValue(false)
  vi.spyOn(selection, 'rangeCount', 'get').mockReturnValue(1)
  vi.spyOn(selection, 'getRangeAt').mockReturnValue(range)

  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 50, 400, 600))

  return { range, rect }
}

function clearMockSelection() {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  vi.spyOn(selection, 'isCollapsed', 'get').mockReturnValue(true)
  vi.spyOn(selection, 'rangeCount', 'get').mockReturnValue(0)
}

describe('useTextSelection', () => {
  let container: HTMLElement
  let rafCallbacks: Array<() => void>

  beforeEach(() => {
    container = createContainerWithText()
    rafCallbacks = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb as () => void)
      return rafCallbacks.length
    })
  })

  afterEach(() => {
    container.remove()
    vi.restoreAllMocks()
  })

  function flushRaf() {
    const cbs = [...rafCallbacks]
    rafCallbacks = []
    cbs.forEach(cb => cb())
  }

  it('detects text selection on mouseup', () => {
    const ref = { current: container }
    const { result } = renderHook(() => useTextSelection(ref))

    expect(result.current.selection).toBeNull()

    mockSelection(container, 'Hello')

    act(() => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      flushRaf()
    })

    expect(result.current.selection).not.toBeNull()
    expect(result.current.selection!.text).toBe('Hello')
  })

  it('clears selection on mousedown outside comment overlay', () => {
    const ref = { current: container }
    const { result } = renderHook(() => useTextSelection(ref))

    mockSelection(container, 'Hello')
    act(() => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      flushRaf()
    })
    expect(result.current.selection).not.toBeNull()

    clearMockSelection()
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(result.current.selection).toBeNull()
  })

  it('preserves selection when mousedown is inside [data-comment-overlay]', () => {
    const ref = { current: container }
    const { result } = renderHook(() => useTextSelection(ref))

    mockSelection(container, 'Hello')
    act(() => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      flushRaf()
    })
    expect(result.current.selection).not.toBeNull()

    const overlay = document.createElement('div')
    overlay.setAttribute('data-comment-overlay', '')
    const button = document.createElement('button')
    overlay.appendChild(button)
    document.body.appendChild(overlay)

    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(result.current.selection).not.toBeNull()
    overlay.remove()
  })

  it('ignores selection outside the container', () => {
    const ref = { current: container }
    const { result } = renderHook(() => useTextSelection(ref))

    const outsideDiv = document.createElement('div')
    outsideDiv.textContent = 'outside text'
    document.body.appendChild(outsideDiv)

    const range = document.createRange()
    range.setStart(outsideDiv.firstChild!, 0)
    range.setEnd(outsideDiv.firstChild!, 7)
    range.getClientRects = () => [new DOMRect(100, 200, 50, 16)] as unknown as DOMRectList

    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    vi.spyOn(selection, 'toString').mockReturnValue('outside')
    vi.spyOn(selection, 'isCollapsed', 'get').mockReturnValue(false)
    vi.spyOn(selection, 'rangeCount', 'get').mockReturnValue(1)
    vi.spyOn(selection, 'getRangeAt').mockReturnValue(range)

    act(() => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      flushRaf()
    })

    expect(result.current.selection).toBeNull()
    outsideDiv.remove()
  })

  it('clearSelection resets state and browser ranges', () => {
    const ref = { current: container }
    const { result } = renderHook(() => useTextSelection(ref))

    mockSelection(container, 'Hello')
    act(() => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      flushRaf()
    })
    expect(result.current.selection).not.toBeNull()

    act(() => result.current.clearSelection())

    expect(result.current.selection).toBeNull()
  })
})
