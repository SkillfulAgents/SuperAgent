// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { WidgetBoard, repackLayout } from './widget-grid'

describe('responsive layout packing', () => {
  it('repacks an overflowing desktop row across narrower columns', () => {
    const packed = repackLayout(
      Array.from({ length: 6 }, (_, x) => ({ id: String(x), x, y: 0, w: 1, h: 1 })),
      2
    )

    expect(packed.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ])
  })
})

describe('WidgetBoard pointer behavior', () => {
  it('keeps vertical touch panning enabled', () => {
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <span>Alpha</span>}
        onCommit={vi.fn()}
      />
    )

    const widget = screen.getByText('Alpha').closest('[data-widget-id]')
    expect(widget).toHaveClass('touch-pan-y')
    expect(widget).not.toHaveClass('touch-none')
  })

  it('cancels a tentative drag without committing when the browser claims the gesture', () => {
    const onCommit = vi.fn()
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <span>Alpha</span>}
        onCommit={onCommit}
      />
    )

    const widget = screen.getByText('Alpha').closest('[data-widget-id]')
    expect(widget).not.toBeNull()

    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 30, clientY: 30 })
    fireEvent.pointerCancel(window)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits a completed drag', () => {
    const onCommit = vi.fn()
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <span>Alpha</span>}
        onCommit={onCommit}
      />
    )

    const widget = screen.getByText('Alpha').closest('[data-widget-id]')
    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 250 })
    fireEvent.pointerUp(window)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({
      alpha: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), w: 1, h: 1 }),
    })
  })

  it('does not arm direct dragging from an interactive control', () => {
    const onCommit = vi.fn()
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <button type="button">Stop agent</button>}
        onCommit={onCommit}
      />
    )

    const control = screen.getByRole('button', { name: 'Stop agent' })
    fireEvent.pointerDown(control, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 250 })
    fireEvent.pointerUp(window)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('removes active window listeners without committing when unmounted mid-drag', () => {
    const onCommit = vi.fn()
    const { unmount } = renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <span>Alpha</span>}
        onCommit={onCommit}
      />
    )

    const widget = screen.getByText('Alpha').closest('[data-widget-id]')
    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 250 })
    unmount()
    fireEvent.pointerUp(window)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not arm a drag when drag gestures are disabled', () => {
    const onCommit = vi.fn()
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <span>Alpha</span>}
        onCommit={onCommit}
        dragEnabled={false}
      />
    )

    const widget = screen.getByText('Alpha').closest('[data-widget-id]')
    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 80 })
    fireEvent.pointerUp(window)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('uses the whole card as a touch-safe, subtly animated arrange handle', () => {
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <button type="button">Alpha action</button>}
        onCommit={vi.fn()}
        arranging
        disableContextMenu
      />
    )

    const widget = screen.getByRole('button', { name: 'Alpha action' }).closest('[data-widget-id]')
    expect(widget).toHaveClass('touch-none')
    expect(widget).not.toHaveClass('touch-pan-y')
    expect(widget?.firstElementChild).toHaveClass('home-card-jiggle')

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    widget?.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)
  })

  it('keeps desktop context menus enabled while arranging', () => {
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'alpha', defaultSize: 'S' }]}
        renderItem={() => <button type="button">Alpha action</button>}
        onCommit={vi.fn()}
        arranging
        disableContextMenu={false}
      />
    )

    const widget = screen.getByRole('button', { name: 'Alpha action' }).closest('[data-widget-id]')
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    widget?.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(false)
  })
})
