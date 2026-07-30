// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { WidgetBoard } from './widget-grid'

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
})
