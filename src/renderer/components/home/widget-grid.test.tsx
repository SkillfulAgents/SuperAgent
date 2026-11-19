// @vitest-environment jsdom
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@renderer/test/test-utils'
import { WidgetBoard, repackLayout, type GridRect, type WidgetItem, type WidgetSizeKey } from './widget-grid'

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

  it('allows a marked full-card link to initiate direct desktop dragging', () => {
    const onCommit = vi.fn()
    renderWithProviders(
      <WidgetBoard
        items={[{ id: 'dashboard', defaultSize: 'S' }]}
        renderItem={() => (
          <a href="/dashboard" draggable={false} data-widget-drag-surface="">
            Open app
          </a>
        )}
        onCommit={onCommit}
      />
    )

    const link = screen.getByRole('link', { name: 'Open app' })
    fireEvent.pointerDown(link, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 250 })
    fireEvent.pointerUp(window)

    expect(onCommit).toHaveBeenCalledTimes(1)
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

// jsdom has no layout: the board measures 0px wide, so it keeps its defaults of
// 4 columns of 216px cells (232px per column, 256px per row) with its origin at
// 0,0. Pointer coordinates below are chosen against that geometry.
const UNIT_X = 232
const UNIT_Y = 256

describe('WidgetBoard drag rendering', () => {
  const renders = new Map<string, number>()
  function Card({ id, label }: { id: string; label?: string }) {
    renders.set(id, (renders.get(id) ?? 0) + 1)
    return <span>{label ?? id}</span>
  }
  const tile = (id: string) => screen.getByText(id).closest<HTMLElement>('[data-widget-id]')!
  const at = (id: string) => ({ left: tile(id).style.left, top: tile(id).style.top })
  const row = (ids: string[]): WidgetItem[] =>
    ids.map((id, x) => ({ id, defaultSize: 'S' as const, rect: { x, y: 0, w: 1, h: 1 } }))
  const snapshot = () => new Map(renders)

  function setup(ids: string[], onCommit = vi.fn()) {
    renders.clear()
    const items = row(ids)
    // One function for the life of the test, as HomePage's is for the life of a
    // drag (it does not re-render while a card is being dragged).
    const renderItem = (id: string) => <Card id={id} />
    const view = render(<WidgetBoard items={items} renderItem={renderItem} onCommit={onCommit} />)
    return { items, renderItem, onCommit, ...view }
  }

  function startDrag(id: string) {
    fireEvent.pointerDown(tile(id), { button: 0, clientX: 20, clientY: 20 })
    // Past the 5px threshold, still inside the card's own cell.
    fireEvent.pointerMove(window, { clientX: 30, clientY: 30 })
    expect(screen.getByTestId('widget-drop-preview')).toBeInTheDocument()
  }

  it('re-renders no card while the pointer stays inside one snapped cell', () => {
    setup(['a', 'b', 'c', 'd'])
    startDrag('a')
    const before = snapshot()

    for (let i = 0; i < 20; i++) fireEvent.pointerMove(window, { clientX: 31 + i, clientY: 31 + i })

    // The dragged tile follows the pointer...
    expect(at('a')).toEqual({ left: '30px', top: '30px' })
    // ...and none of the cards rendered again, the dragged one included.
    expect(renders).toEqual(before)
  })

  it('moves the displaced tiles without re-rendering their cards when the drop target changes', () => {
    setup(['a', 'b', 'c', 'd'])
    startDrag('a')
    const before = snapshot()
    expect(at('b')).toEqual({ left: `${UNIT_X}px`, top: '0px' })

    // Over b's cell: b is pushed down a row, the others stay.
    fireEvent.pointerMove(window, { clientX: 20 + UNIT_X, clientY: 20 })

    expect(at('b')).toEqual({ left: `${UNIT_X}px`, top: `${UNIT_Y}px` })
    expect(at('c')).toEqual({ left: `${2 * UNIT_X}px`, top: '0px' })
    const preview = screen.getByTestId('widget-drop-preview')
    expect(preview.style.left).toBe(`${UNIT_X}px`)
    expect(preview.style.top).toBe('0px')
    expect(renders).toEqual(before)

    // Back over its own cell: b returns.
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 })
    expect(at('b')).toEqual({ left: `${UNIT_X}px`, top: '0px' })
    expect(renders).toEqual(before)
  })

  it('commits the layout of the last drop target after moves that stay in that cell', () => {
    const { onCommit } = setup(['a', 'b', 'c'])
    startDrag('a')
    fireEvent.pointerMove(window, { clientX: 20 + UNIT_X, clientY: 20 })
    for (let i = 0; i < 5; i++) fireEvent.pointerMove(window, { clientX: 21 + i + UNIT_X, clientY: 21 + i })
    fireEvent.pointerUp(window)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({
      a: { x: 1, y: 0, w: 1, h: 1 },
      b: { x: 1, y: 1, w: 1, h: 1 },
      c: { x: 2, y: 0, w: 1, h: 1 },
    })
    expect(screen.queryByTestId('widget-drop-preview')).toBeNull()
  })

  it('follows the pointer through several cells and commits where it ends', () => {
    const { onCommit } = setup(['a', 'b', 'c'])
    startDrag('a')
    fireEvent.pointerMove(window, { clientX: 20 + UNIT_X, clientY: 20 })
    fireEvent.pointerMove(window, { clientX: 20 + 2 * UNIT_X, clientY: 20 })
    fireEvent.pointerMove(window, { clientX: 20 + 3 * UNIT_X, clientY: 20 + UNIT_Y })
    fireEvent.pointerUp(window)

    // Dropped in the empty fourth column, a row down: nothing is displaced.
    expect(onCommit).toHaveBeenCalledWith({
      a: { x: 3, y: 1, w: 1, h: 1 },
      b: { x: 1, y: 0, w: 1, h: 1 },
      c: { x: 2, y: 0, w: 1, h: 1 },
    })
  })

  it('puts every tile back when the gesture is cancelled over another cell', () => {
    const { onCommit } = setup(['a', 'b', 'c'])
    startDrag('a')
    fireEvent.pointerMove(window, { clientX: 20 + UNIT_X, clientY: 20 })
    expect(at('b').top).toBe(`${UNIT_Y}px`)
    const before = snapshot()

    fireEvent.pointerCancel(window)

    expect(onCommit).not.toHaveBeenCalled()
    expect(at('a')).toEqual({ left: '0px', top: '0px' })
    expect(at('b')).toEqual({ left: `${UNIT_X}px`, top: '0px' })
    expect(screen.queryByTestId('widget-drop-preview')).toBeNull()
    expect(renders).toEqual(before)
  })

  it("starts each drag from the current layout, not the previous drag's preview", () => {
    const { onCommit } = setup(['a', 'b', 'c'])
    startDrag('a')
    fireEvent.pointerMove(window, { clientX: 20 + UNIT_X, clientY: 20 })
    fireEvent.pointerCancel(window)

    // A second drag that never leaves the card's own cell commits the layout as it was.
    startDrag('a')
    fireEvent.pointerUp(window)
    expect(onCommit).toHaveBeenCalledWith({
      a: { x: 0, y: 0, w: 1, h: 1 },
      b: { x: 1, y: 0, w: 1, h: 1 },
      c: { x: 2, y: 0, w: 1, h: 1 },
    })
  })

  it('rebuilds the cards when the parent hands it a new renderItem, mid-drag included', () => {
    const { items, rerender } = setup(['a', 'b'])
    startDrag('a')

    rerender(
      <WidgetBoard items={items} renderItem={(id) => <Card id={id} label={`${id} (running)`} />} onCommit={vi.fn()} />
    )

    expect(screen.getByText('a (running)')).toBeInTheDocument()
    expect(screen.getByText('b (running)')).toBeInTheDocument()
    // The drag itself survives the parent's render.
    expect(screen.getByTestId('widget-drop-preview')).toBeInTheDocument()
  })

  it('rebuilds the cards when the layout changes under the same renderItem', () => {
    const { renderItem, rerender } = setup(['a', 'b'])
    const before = snapshot()

    rerender(
      <WidgetBoard
        items={[
          { id: 'a', defaultSize: 'S', rect: { x: 0, y: 0, w: 2, h: 1 } },
          { id: 'b', defaultSize: 'S', rect: { x: 2, y: 0, w: 1, h: 1 } },
        ]}
        renderItem={renderItem}
        onCommit={vi.fn()}
      />
    )

    expect(renders.get('a')).toBeGreaterThan(before.get('a')!)
    expect(tile('a').style.width).toBe(`${2 * 216 + 16}px`)
  })

  it('resizes against the latest layout and onCommit from a card built earlier', () => {
    // A stable renderItem keeps the first render's elements (and their onResize)
    // alive across parent renders that only swap onCommit.
    const resizers = new Map<string, (size: WidgetSizeKey) => void>()
    const renderItem = (id: string, _size: WidgetSizeKey, onResize: (size: WidgetSizeKey) => void) => {
      resizers.set(id, onResize)
      return <span>{id}</span>
    }
    const first = vi.fn()
    const second = vi.fn()
    const items = row(['a', 'b'])
    const { rerender } = render(<WidgetBoard items={items} renderItem={renderItem} onCommit={first} />)
    const builtFirst = resizers.get('a')!

    rerender(<WidgetBoard items={items} renderItem={renderItem} onCommit={second} />)
    expect(resizers.get('a')).toBe(builtFirst)

    act(() => builtFirst('W'))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({
      a: { x: 0, y: 0, w: 2, h: 1 },
      b: { x: 1, y: 1, w: 1, h: 1 },
    })
  })

  it('keeps a committed order once the parent applies it', () => {
    renders.clear()
    function Harness() {
      const [layout, setLayout] = useState<Record<string, GridRect>>({
        a: { x: 0, y: 0, w: 1, h: 1 },
        b: { x: 1, y: 0, w: 1, h: 1 },
      })
      const items: WidgetItem[] = ['a', 'b'].map((id) => ({ id, defaultSize: 'S', rect: layout[id] }))
      return <WidgetBoard items={items} renderItem={(id) => <Card id={id} />} onCommit={setLayout} />
    }
    render(<Harness />)

    startDrag('a')
    fireEvent.pointerMove(window, { clientX: 20 + 2 * UNIT_X, clientY: 20 })
    fireEvent.pointerUp(window)

    expect(at('a')).toEqual({ left: `${2 * UNIT_X}px`, top: '0px' })
    expect(at('b')).toEqual({ left: `${UNIT_X}px`, top: '0px' })
  })
})
