// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideToConfirm } from './slide-to-confirm'

/* jsdom has no layout, so the track's rect is all zeros and `local()` falls
   back to a 1:1 scale: clientX IS the handle's own coordinate. The first
   move after a press only takes the grab offset, so a slide is a press, a
   settling move, the move that matters, and the release. */
const slide = (handle: HTMLElement, to: number, button = 0) => {
  fireEvent.pointerDown(handle, { pointerId: 1, button, clientX: 0 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to })
}

/* the default 280px track: 280 - 8 - 48 of travel */
const END = 224

const flush = () => act(async () => {})

beforeEach(() => {
  /* the springs are not under test; park every frame so nothing moves */
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SlideToConfirm', () => {
  it('ignores a slide that stops short of the end', () => {
    const onConfirm = vi.fn()
    render(<SlideToConfirm label="Slide to delete" onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    slide(handle, END / 2)

    expect(onConfirm).not.toHaveBeenCalled()
    expect(handle).toHaveAttribute('aria-label', 'Slide to delete')
  })

  it('commits once the handle reaches the end of the track, and only once', () => {
    const onConfirm = vi.fn()
    render(
      <SlideToConfirm label="Slide to delete" confirmedLabel="Deleted" onConfirm={onConfirm} data-testid="handle" />,
    )
    const handle = screen.getByTestId('handle')

    slide(handle, END + 200)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(handle).toHaveAttribute('aria-label', 'Deleted')
    expect(handle.parentElement).toHaveAttribute('data-done')

    slide(handle, END + 200)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('a right-button press is not a grab', () => {
    const onConfirm = vi.fn()
    render(<SlideToConfirm onConfirm={onConfirm} data-testid="handle" />)

    slide(screen.getByTestId('handle'), END + 200, 2)

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter or Space on the focused handle commits', () => {
    const onConfirm = vi.fn()
    render(<SlideToConfirm onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    fireEvent.keyDown(handle, { key: 'Tab' })
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows busy while a returned promise is pending', () => {
    const onConfirm = vi.fn(() => new Promise<void>(() => {}))
    render(<SlideToConfirm onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    slide(handle, END + 200)

    expect(handle).toHaveAttribute('aria-busy', 'true')
  })

  it('a rejected promise plays the unfurl back and re-arms the handle', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('nope'))
    render(<SlideToConfirm label="Slide to delete" onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    slide(handle, END + 200)
    expect(handle).toHaveAttribute('aria-busy', 'true')
    await flush()

    expect(handle).not.toHaveAttribute('aria-busy')
    expect(handle).toHaveAttribute('aria-label', 'Slide to delete')
    expect(handle.parentElement).not.toHaveAttribute('data-done')

    slide(handle, END + 200)
    expect(onConfirm).toHaveBeenCalledTimes(2)
    await flush()
    expect(handle).toHaveAttribute('aria-label', 'Slide to delete')
  })

  it('a resolved promise leaves the handle confirmed and no longer busy', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<SlideToConfirm confirmedLabel="Deleted" onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    slide(handle, END + 200)
    await flush()

    expect(handle).not.toHaveAttribute('aria-busy')
    expect(handle).toHaveAttribute('aria-label', 'Deleted')
  })

  it('a release anywhere ends the drag, even off the track', () => {
    const onConfirm = vi.fn()
    render(<SlideToConfirm onConfirm={onConfirm} data-testid="handle" />)
    const handle = screen.getByTestId('handle')

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40 })
    expect(handle.parentElement).toHaveAttribute('data-held')

    fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 40 })
    expect(handle.parentElement).not.toHaveAttribute('data-held')
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
