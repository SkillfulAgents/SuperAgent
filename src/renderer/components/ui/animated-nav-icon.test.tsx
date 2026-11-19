// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnimatedNavIcon } from './animated-nav-icon'

describe('AnimatedNavIcon interaction and motion preferences', () => {
  let reduced = false
  let mediaEvents: EventTarget
  let media: MediaQueryList
  const cancellations: ReturnType<typeof vi.fn>[] = []
  const animate = vi.fn(() => {
    const cancel = vi.fn()
    cancellations.push(cancel)
    return { cancel } as unknown as Animation
  })
  const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

  beforeEach(() => {
    reduced = false
    cancellations.length = 0
    animate.mockClear()
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
    mediaEvents = new EventTarget()
    media = {
      get matches() { return reduced },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(mediaEvents.addEventListener.bind(mediaEvents)),
      removeEventListener: vi.fn(mediaEvents.removeEventListener.bind(mediaEvents)),
      dispatchEvent: mediaEvents.dispatchEvent.bind(mediaEvents),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
    else Reflect.deleteProperty(Element.prototype, 'animate')
  })

  function setReducedMotion(value: boolean) {
    reduced = value
    act(() => { mediaEvents.dispatchEvent(new Event('change')) })
  }

  // jsdom does not derive :focus-visible from input modality.
  function setFocusVisible(row: HTMLElement, visible: boolean) {
    vi.spyOn(row, 'matches').mockImplementation((selector) =>
      selector === ':focus-visible' ? visible : Element.prototype.matches.call(row, selector),
    )
  }

  function renderRow(onClick = vi.fn()) {
    const view = render(
      <button type="button" onClick={onClick}>
        <AnimatedNavIcon name="folder" />
        <span>Drives</span>
      </button>,
    )
    return { ...view, row: screen.getByRole('button', { name: 'Drives' }), onClick }
  }

  it('animates the row and replays on label clicks without intercepting the action', () => {
    const { row, onClick } = renderRow()
    expect(animate).not.toHaveBeenCalled()
    fireEvent.pointerEnter(row)
    expect(animate).toHaveBeenCalledTimes(1)
    const first = cancellations[0]

    fireEvent.click(screen.getByText('Drives'))
    expect(first).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenCalledTimes(2)
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick.mock.calls[0][0].defaultPrevented).toBe(false)
  })

  it('keeps all interactions still when reduced motion is set before mounting', () => {
    reduced = true
    const { row, onClick } = renderRow()
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    setFocusVisible(row, true)
    fireEvent.pointerEnter(row)
    fireEvent.focus(row)
    fireEvent.click(row)
    expect(animate).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('stops in-flight motion when the preference changes and only resumes on interaction', () => {
    const { row } = renderRow()
    fireEvent.pointerEnter(row)
    const running = [...cancellations]
    setReducedMotion(true)
    running.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce())
    animate.mockClear()
    fireEvent.pointerEnter(row)
    fireEvent.click(row)
    expect(animate).not.toHaveBeenCalled()

    setReducedMotion(false)
    expect(animate).not.toHaveBeenCalled()
    fireEvent.pointerEnter(row)
    expect(animate).toHaveBeenCalledOnce()
  })

  it('animates keyboard focus without also replaying on mouse focus', () => {
    const { row } = renderRow()
    setFocusVisible(row, false)
    fireEvent.focus(row)
    expect(animate).not.toHaveBeenCalled()
    setFocusVisible(row, true)
    fireEvent.focus(row)
    expect(animate).toHaveBeenCalledOnce()
  })

  it('waits for a click on touch rather than animating a synthetic hover', () => {
    const { row } = renderRow()
    const enter = new Event('pointerenter')
    Object.defineProperty(enter, 'pointerType', { value: 'touch' })
    fireEvent(row, enter)
    expect(animate).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(animate).toHaveBeenCalledOnce()
  })

  it.each(['disabled', 'aria-disabled'] as const)('keeps a %s row still', (attribute) => {
    const { row } = renderRow()
    row.setAttribute(attribute, 'true')
    fireEvent.pointerEnter(row)
    fireEvent.click(row)
    expect(animate).not.toHaveBeenCalled()
  })

  it('cancels every animated part and removes listeners on unmount', () => {
    const { unmount } = render(
      <a href="#notifications"><AnimatedNavIcon name="bell" />Notifications</a>,
    )
    const row = screen.getByRole('link', { name: 'Notifications' })
    fireEvent.pointerEnter(row)
    expect(cancellations.length).toBeGreaterThan(1)
    unmount()
    cancellations.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce())
    expect(media.removeEventListener).toHaveBeenCalledWith('change', vi.mocked(media.addEventListener).mock.calls[0][1])
    animate.mockClear()
    fireEvent.pointerEnter(row)
    fireEvent.focus(row)
    fireEvent.click(row)
    setReducedMotion(true)
    expect(animate).not.toHaveBeenCalled()
    cancellations.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce())
  })

  it('remains a usable static icon when the animation API is unavailable', () => {
    Reflect.deleteProperty(Element.prototype, 'animate')
    const { row, onClick } = renderRow()
    fireEvent.pointerEnter(row)
    fireEvent.click(row)
    expect(animate).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledOnce()
  })
})
