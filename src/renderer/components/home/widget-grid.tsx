import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MoreVertical } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'

/**
 * Apple-widgets-style snap grid for the agent home page.
 *
 * Cards live on a board of square cells (responsive 2–6 columns). Each card
 * occupies a rect {x, y, w, h} in cell units and comes in two footprints:
 * Small 1×1 and Wide 2×1. Cards are dragged anywhere on the
 * board with a snapped drop-ghost and live reflow of the other cards; a hover
 * pencil opens a popover with the size picker. The parent owns persistence —
 * the board calls onCommit with the full layout map after a drag or resize.
 *
 * Ported from the Claude Design handoff (Agent Homepage prototype): the
 * resolveLayout / flowPack / placeOne packing model and drag interaction are
 * kept; visuals are translated to this app's tokens.
 */

export interface GridRect {
  x: number
  y: number
  w: number
  h: number
}

export type WidgetSizeKey = 'S' | 'W'

export const WIDGET_SIZES: { key: WidgetSizeKey; label: string; w: number; h: number }[] = [
  { key: 'S', label: 'Small', w: 1, h: 1 },
  { key: 'W', label: 'Medium', w: 2, h: 1 },
]

export function widgetSizeKey(w: number, h: number): WidgetSizeKey {
  const s = WIDGET_SIZES.find((s) => s.w === w && s.h === h)
  return s ? s.key : 'W'
}

const GAP = 16 // px between cells
const TARGET_CELL = 232 // desired cell+gap size — drives the column count

interface Placed extends GridRect {
  id: string
}

function collides(a: Placed, b: Placed): boolean {
  return a.id !== b.id && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Pack items to the top; keep `pinnedId` exactly where it is, resolve the rest. */
export function resolveLayout(items: Placed[], pinnedId: string | null): Placed[] {
  const placed: Placed[] = []
  const pin = pinnedId ? items.find((i) => i.id === pinnedId) : null
  if (pin) placed.push({ ...pin })
  const rest = items
    .filter((i) => i.id !== pinnedId)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
  for (const it of rest) {
    const item = { ...it }
    let guard = 0
    while (placed.some((c) => collides(item, c)) && guard++ < 800) item.y++
    while (item.y > 0) {
      item.y--
      if (placed.some((c) => collides(item, c))) {
        item.y++
        break
      }
    }
    placed.push(item)
  }
  return placed
}

/** First free slot for a single new card of size w×h, given existing placements. */
export function placeOne(items: GridRect[], cols: number, w: number, h: number): { x: number; y: number } {
  const occ = new Set<string>()
  for (const it of items) {
    for (let i = it.x; i < it.x + it.w; i++)
      for (let j = it.y; j < it.y + it.h; j++) occ.add(i + ',' + j)
  }
  const fits = (x: number, y: number) => {
    if (x + w > cols) return false
    for (let i = x; i < x + w; i++)
      for (let j = y; j < y + h; j++) if (occ.has(i + ',' + j)) return false
    return true
  }
  for (let y = 0; y < 2000; y++) {
    for (let x = 0; x <= cols - w; x++) if (fits(x, y)) return { x, y }
  }
  return { x: 0, y: 0 }
}

export interface WidgetItem {
  id: string
  /** Saved rect, if the user has customized the layout. */
  rect?: GridRect
  /** Footprint used when there is no saved rect. */
  defaultSize: WidgetSizeKey
}

interface WidgetBoardProps {
  items: WidgetItem[]
  /** Caller renders the item and builds its own size-picker (via WidgetSizePopover
   *  + onResize) so it can add card-specific controls and align it in a row. */
  renderItem: (id: string, size: WidgetSizeKey, onResize: (size: WidgetSizeKey) => void) => ReactNode
  /** Called with the full layout map after any user drag or resize. */
  onCommit: (layout: Record<string, GridRect>) => void
}

interface DragState {
  id: string
  left: number
  top: number
  w: number
  h: number
  target: { x: number; y: number }
  preview: Placed[]
}

export function WidgetBoard({ items, renderItem, onCommit }: WidgetBoardProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(4)
  const [cellW, setCellW] = useState(216)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const wpx = el.clientWidth
      const c = Math.max(2, Math.min(6, Math.round((wpx + GAP) / TARGET_CELL)))
      setCols(c)
      setCellW((wpx - (c - 1) * GAP) / c)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Saved rects (clamped to the column count, collisions resolved) plus
  // flow-packed placement for items without one. Recomputes on resize, so
  // uncustomized boards stay responsively packed.
  const placed = useMemo<Placed[]>(() => {
    const out: Placed[] = []
    for (const it of items) {
      if (!it.rect) continue
      const w = Math.min(it.rect.w, cols)
      // Clamp to 1-tall: layouts saved before the Tall/Large sizes were removed
      // may still carry h:2 rects.
      out.push({ id: it.id, w, h: Math.min(it.rect.h, 1), x: Math.min(it.rect.x, cols - w), y: it.rect.y })
    }
    let resolved = resolveLayout(out, null)
    for (const it of items) {
      if (it.rect) continue
      const def = WIDGET_SIZES.find((s) => s.key === it.defaultSize) ?? WIDGET_SIZES[WIDGET_SIZES.length - 1]
      const w = Math.min(def.w, cols)
      const spot = placeOne(resolved, cols, w, def.h)
      resolved = [...resolved, { id: it.id, x: spot.x, y: spot.y, w, h: def.h }]
    }
    // keep render order stable (items order), but use resolved geometry
    const map = new Map(resolved.map((p) => [p.id, p]))
    return items.map((it) => map.get(it.id)!).filter(Boolean)
  }, [items, cols])

  const unit = cellW + GAP
  const pos = (g: GridRect) => ({
    left: g.x * unit,
    top: g.y * unit,
    width: g.w * cellW + (g.w - 1) * GAP,
    height: g.h * cellW + (g.h - 1) * GAP,
  })

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  // Suppresses the click that follows a drag release, so dragging a card
  // doesn't also open the agent.
  const didDragRef = useRef(false)

  const commitFromPlaced = (grids: Placed[]) => {
    const layout: Record<string, GridRect> = {}
    for (const g of grids) layout[g.id] = { x: g.x, y: g.y, w: g.w, h: g.h }
    onCommit(layout)
  }

  function onPointerDown(e: React.PointerEvent, item: Placed) {
    if (e.button !== 0) return
    // Drag can start anywhere on the card — our cards are themselves <button>s,
    // so we can't exclude interactive elements generically. Inner controls keep
    // working because a drag only arms after 5px of movement (a plain click
    // never moves) and only an actual drag swallows the following click.
    // data-widget-no-drag opts out the pencil/popover explicitly.
    const target = e.target as HTMLElement
    if (target.closest('[data-widget-no-drag]')) return
    const board = wrapRef.current
    if (!board) return
    const boardRect = board.getBoundingClientRect()
    const p = pos(item)
    const startX = e.clientX
    const startY = e.clientY
    const dx = e.clientX - (boardRect.left + p.left)
    const dy = e.clientY - (boardRect.top + p.top)
    let started = false

    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      if (!started) {
        started = true
        didDragRef.current = true
      }
      const left = ev.clientX - boardRect.left - dx
      const top = ev.clientY - boardRect.top - dy
      const maxX = cols - item.w
      const tx = Math.max(0, Math.min(maxX, Math.round(left / unit)))
      const ty = Math.max(0, Math.round(top / unit))
      const moved = placed.map((g) => (g.id === item.id ? { ...g, x: tx, y: ty } : g))
      const preview = resolveLayout(moved, item.id)
      setDrag({ id: item.id, left, top, w: item.w, h: item.h, target: { x: tx, y: ty }, preview })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = dragRef.current
      if (d?.preview) commitFromPlaced(d.preview)
      setDrag(null)
      // Allow the click that follows this pointerup to be swallowed, then reset.
      setTimeout(() => {
        didDragRef.current = false
      }, 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function setSize(item: Placed, size: WidgetSizeKey) {
    const def = WIDGET_SIZES.find((s) => s.key === size)
    if (!def) return
    const w = Math.min(def.w, cols)
    const x = Math.min(item.x, Math.max(0, cols - w))
    const next = placed.map((g) => (g.id === item.id ? { ...g, x, w, h: def.h } : g))
    commitFromPlaced(resolveLayout(next, item.id))
  }

  const previewMap = new Map<string, Placed>()
  if (drag?.preview) for (const g of drag.preview) previewMap.set(g.id, g)

  const rows = Math.max(
    1,
    ...placed.map((g) => {
      const eff = previewMap.get(g.id) ?? g
      return eff.y + eff.h
    }),
    drag ? drag.target.y + drag.h : 0
  )
  const boardH = rows * unit - GAP + (drag ? unit : 0)

  return (
    <div
      ref={wrapRef}
      className="relative w-full transition-[height] duration-200 ease-out"
      style={{ height: Math.max(boardH, unit) }}
    >
      {drag && (
        <div
          className="absolute rounded-lg bg-muted/40 transition-[left,top] duration-100"
          style={{
            left: drag.target.x * unit,
            top: drag.target.y * unit,
            width: drag.w * cellW + (drag.w - 1) * GAP,
            height: drag.h * cellW + (drag.h - 1) * GAP,
          }}
        />
      )}

      {placed.map((item) => {
        const isDragging = drag?.id === item.id
        const g = previewMap.get(item.id) ?? item
        const p = pos(g)
        const style = isDragging
          ? { left: drag!.left, top: drag!.top, width: p.width, height: p.height, zIndex: 50 }
          : { left: p.left, top: p.top, width: p.width, height: p.height }
        return (
          <div
            key={item.id}
            data-widget-id={item.id}
            className={cn(
              'group/widget absolute touch-none',
              // Tiles glide to new positions (reflow, drop-settle) but snap
              // their size in one frame — tweening width/height fights the
              // card's contents (instant inner-layout swap + the halftone
              // canvas re-initializing every frame). The actively-dragged tile
              // must track the pointer with zero lag.
              isDragging
                ? 'scale-[1.02] cursor-grabbing drop-shadow-xl'
                : 'transition-[left,top] duration-200 ease-out'
            )}
            style={style}
            onPointerDown={(e) => onPointerDown(e, item)}
            onClickCapture={(e) => {
              if (didDragRef.current) {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
          >
            <div className="h-full w-full">
              {renderItem(item.id, widgetSizeKey(item.w, item.h), (s) => setSize(item, s))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Label + small switch row for the card-options popover (size + per-card toggles). */
export function WidgetToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 px-1 py-1 text-xs"
    >
      <span>{label}</span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-input'
        )}
      >
        <span
          className={cn(
            'block h-3 w-3 rounded-full bg-background shadow transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </span>
    </button>
  )
}

export function WidgetSizePopover({
  size,
  onPick,
  extra,
}: {
  size: WidgetSizeKey
  onPick: (s: WidgetSizeKey) => void
  /** Optional extra controls rendered below the size toggle (e.g. a per-agent
   *  toggle). Receives a close() so layout-mutating actions can dismiss the
   *  menu before its anchor moves. */
  extra?: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-widget-no-drag
          aria-label="Card options"
          title="Card options"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            // Same size as the status chip's stop button (h-5 w-5). The caller
            // places it in an items-center row so it centers against the chip.
            // Hidden until the card is hovered.
            'hidden h-5 w-5 items-center justify-center rounded border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground group-hover/widget:flex',
            open && 'flex bg-muted text-foreground'
          )}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-40 p-1.5"
        data-widget-no-drag
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ON = the 2×1 card with notifications + health; OFF = the 1×1 glance tile.
            Every action here mutates the grid layout, which moves the popover's
            anchor mid-flight — so close the menu immediately on any action
            instead of letting it chase the resizing card. */}
        <WidgetToggleRow
          label="Expanded"
          checked={size === 'W'}
          onToggle={() => {
            setOpen(false)
            onPick(size === 'W' ? 'S' : 'W')
          }}
        />
        {(() => {
          const extraContent = extra?.(() => setOpen(false))
          return extraContent ? <div className="mt-1 border-t pt-1">{extraContent}</div> : null
        })()}
      </PopoverContent>
    </Popover>
  )
}
