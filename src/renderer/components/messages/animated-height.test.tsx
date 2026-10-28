// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimatedHeight } from './animated-height'

describe('AnimatedHeight', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('glides from the last settled height to the new one, then lets the frame float again', () => {
    vi.useFakeTimers()
    let callback: ResizeObserverCallback | null = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) { callback = cb }
      observe() {}
      disconnect() {}
    })
    let height = 80
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.probe === 'content' ? height : 0
    })
    const { container } = render(<AnimatedHeight><div data-probe="content" /></AnimatedHeight>)
    const frame = container.firstElementChild as HTMLDivElement
    const content = frame.firstElementChild as HTMLDivElement
    content.dataset.probe = 'content'

    height = 200
    callback!([], {} as ResizeObserver)
    expect(frame.style.height).toBe('200px')
    expect(frame.style.transition).toContain('height')
    expect(frame.style.overflow).toBe('hidden')

    vi.advanceTimersByTime(400)
    expect(frame.style.height).toBe('')
    expect(frame.style.overflow).toBe('')
    vi.unstubAllGlobals()
  })
})
