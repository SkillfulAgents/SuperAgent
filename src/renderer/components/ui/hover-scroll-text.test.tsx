// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOVER_SCROLL_DELAY_MS,
  HoverScrollText,
} from './hover-scroll-text'

function setTextWidths(viewport: HTMLElement, content: HTMLElement, viewportWidth: number, contentWidth: number) {
  Object.defineProperty(viewport, 'clientWidth', {
    configurable: true,
    value: viewportWidth,
  })
  Object.defineProperty(content, 'scrollWidth', {
    configurable: true,
    value: contentWidth,
  })
}

describe('HoverScrollText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits before scrolling clipped text and resets as soon as hover ends', () => {
    render(<HoverScrollText data-testid="label">A long session name</HoverScrollText>)
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 100, 145)

    fireEvent.mouseEnter(viewport)
    expect(viewport).toHaveAttribute('data-overflowing', 'true')
    expect(viewport).toHaveAttribute('data-scrolling', 'false')

    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS - 1))
    expect(viewport).toHaveAttribute('data-scrolling', 'false')

    act(() => vi.advanceTimersByTime(1))
    expect(viewport).toHaveAttribute('data-scrolling', 'true')
    expect(viewport).toHaveStyle({
      '--hover-scroll-distance': '45px',
      '--hover-scroll-duration': '1406ms',
    })

    fireEvent.mouseLeave(viewport)
    expect(viewport).toHaveAttribute('data-scrolling', 'false')
  })

  it('keeps panning when a re-render hands it the same words in a new element', () => {
    // The activity card re-renders every second for its elapsed clock, so its
    // rows arrive as a fresh element with identical text. Treating that as new
    // content cancelled the pan mid-flight and snapped the row back to the
    // start — the sidebar never saw it because its child is a plain string.
    const row = (
      <>
        <span>web-browser</span>
        <span> Gather UniFi WiFi events</span>
      </>
    )
    const { rerender } = render(<HoverScrollText data-testid="label">{row}</HoverScrollText>)
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 100, 145)

    fireEvent.mouseEnter(viewport)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))
    expect(viewport).toHaveAttribute('data-scrolling', 'true')

    rerender(
      <HoverScrollText data-testid="label">
        <>
          <span>web-browser</span>
          <span> Gather UniFi WiFi events</span>
        </>
      </HoverScrollText>
    )
    expect(viewport).toHaveAttribute('data-scrolling', 'true')
  })

  it('re-arms the pan when the text itself changes mid-hover', () => {
    const { rerender } = render(<HoverScrollText data-testid="label">A long session name</HoverScrollText>)
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 100, 145)

    fireEvent.mouseEnter(viewport)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))
    expect(viewport).toHaveAttribute('data-scrolling', 'true')

    // New words under the pointer: the old measurement is stale, so it restarts
    // from the dwell rather than either stalling or panning the wrong distance.
    rerender(<HoverScrollText data-testid="label">A different long session name</HoverScrollText>)
    expect(viewport).toHaveAttribute('data-scrolling', 'false')
    setTextWidths(viewport, content, 100, 200)

    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS - 1))
    expect(viewport).toHaveAttribute('data-scrolling', 'false')

    act(() => vi.advanceTimersByTime(1))
    expect(viewport).toHaveAttribute('data-scrolling', 'true')
    expect(viewport).toHaveStyle({ '--hover-scroll-distance': '100px' })
  })

  it('does not animate text that fits', () => {
    render(<HoverScrollText data-testid="label">Short name</HoverScrollText>)
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 120, 80)

    fireEvent.mouseEnter(viewport)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))

    expect(viewport).toHaveAttribute('data-overflowing', 'false')
    expect(viewport).toHaveAttribute('data-scrolling', 'false')
  })

  it('can use the entire parent row as its hover target', () => {
    render(
      <span data-testid="row">
        <HoverScrollText data-testid="label" hoverTarget="parent">
          A long session name
        </HoverScrollText>
        <span data-testid="status">Status</span>
      </span>
    )
    const row = screen.getByTestId('row')
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 100, 145)

    fireEvent.mouseEnter(row)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))
    expect(viewport).toHaveAttribute('data-scrolling', 'true')

    // Moving from the text into another part of the row must not reset it.
    fireEvent.mouseLeave(viewport)
    expect(viewport).toHaveAttribute('data-scrolling', 'true')

    fireEvent.mouseLeave(row)
    expect(viewport).toHaveAttribute('data-scrolling', 'false')
  })

  it('keeps clipped text still when reduced motion is requested', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    render(<HoverScrollText data-testid="label">A long session name</HoverScrollText>)
    const viewport = screen.getByTestId('label')
    const content = viewport.firstElementChild as HTMLElement
    setTextWidths(viewport, content, 100, 145)

    fireEvent.mouseEnter(viewport)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))

    expect(viewport).toHaveAttribute('data-overflowing', 'true')
    expect(viewport).toHaveAttribute('data-scrolling', 'false')
  })
})
