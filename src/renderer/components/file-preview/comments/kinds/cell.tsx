import type { RefObject } from 'react'
import { quoted, type AnchorKindSpec, type MarkerProps, type PointerAt } from './types'

export interface CellRef {
  /** 1-based data row index (header row excluded). */
  row: number
  /** 0-based column index, used to place the comment pin in the grid. */
  col: number
  /** Column header name (or "Column N" when the header is blank). */
  column: string
  /** Current cell value, included as context for the agent. */
  value?: string
}
export interface CellAnchor {
  kind: 'cell'
  cell: CellRef
}
export interface CellSurface {
  /** Cells inside it carry `data-comment-cell="row:col"`. */
  grid: RefObject<HTMLElement | null>
  cellAt: (row: number, col: number) => CellRef | undefined
}

function cellUnder({ grid, cellAt }: CellSurface, at: PointerAt): CellAnchor | null {
  const td = at.target.closest('[data-comment-cell]')
  if (!td || !grid.current?.contains(td)) return null
  const [row, col] = (td.getAttribute('data-comment-cell') ?? '').split(':').map(Number)
  const cell = cellAt(row, col)
  return cell ? { kind: 'cell', cell } : null
}

function CellMarker({ numbers, isOpen }: MarkerProps<CellAnchor, CellSurface>) {
  if (isOpen) return <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-primary" />
  return (
    <>
      <span className="pointer-events-none absolute inset-0 bg-primary/10" />
      <span
        className="absolute top-0.5 right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-medium leading-[0.875rem] text-center shadow-sm pointer-events-none"
        title={`${numbers.length} comment${numbers.length === 1 ? '' : 's'}`}
      >
        {numbers.length}
      </span>
    </>
  )
}

export const cellKind: AnchorKindSpec<CellAnchor, CellSurface> = {
  fromClick: cellUnder,
  fromMouse: cellUnder,
  describe: ({ cell: { row, col, column, value } }) => {
    // The 1-based column position keeps duplicate header names unambiguous.
    const ref = `${row}:${column} (col ${col + 1}`
    if (value === undefined) return `At cell ${ref})`
    if (value === '') return `At cell ${ref}, empty cell)`
    return `At cell ${ref}, value: ${quoted(value)})`
  },
  locate: ({ grid }, { cell }) => {
    const host = grid.current?.querySelector(`[data-comment-cell="${cell.row}:${cell.col}"]`)
    return host ? [{ host, x: 100, y: 0 }] : []
  },
  group: true,
  Marker: CellMarker,
}
