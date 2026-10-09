import { formatCommentTime } from './format-media-time'

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

/** A position as percentages of the image or frame. */
interface Point {
  x: number
  y: number
}

/** Where a comment points in its file. */
export type CommentAnchor =
  | { kind: 'cell'; cell: CellRef }
  | { kind: 'text'; quote: string }
  | { kind: 'time'; seconds: number; point?: Point }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'file' }

/** Cap long cell values so a single comment can't bloat the prompt. */
function truncateValue(value: string, max = 200): string {
  return value.length > max ? value.slice(0, max) + '…' : value
}

/** Escape double quotes so a value containing `"` can't unbalance the wrapper. */
function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"')
}

function describePoint({ x, y }: Point): string {
  return `position (${Math.round(x)}%, ${Math.round(y)}%)`
}

/** The one description of an anchor, for the comment box, the list row, and the agent text. */
export function describeAnchor(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case 'cell': {
      const { row, col, column, value } = anchor.cell
      // The 1-based column position keeps duplicate header names unambiguous.
      const ref = `${row}:${column} (col ${col + 1}`
      if (value === undefined) return `At cell ${ref})`
      if (value === '') return `At cell ${ref}, empty cell)`
      return `At cell ${ref}, value: "${escapeQuotes(truncateValue(value))}")`
    }
    case 'text':
      return `> "${anchor.quote}"`
    case 'time':
      return `At ${formatCommentTime(anchor.seconds)}${anchor.point ? ` at ${describePoint(anchor.point)}` : ''}`
    case 'point':
      return `At ${describePoint(anchor)}`
    case 'file':
      return 'Whole file'
  }
}

/** What a viewer hands the comment box today, before viewers produce anchors themselves. */
export interface PendingSelection {
  text: string
  x?: number
  y?: number
  cell?: CellRef
  /** Playback position in seconds, set for audio/video comments. */
  timestamp?: number
}

/** The anchor a viewer's pending selection describes. */
export function selectionToAnchor({ text, x, y, cell, timestamp }: PendingSelection): CommentAnchor {
  if (cell) return { kind: 'cell', cell }
  if (text) return { kind: 'text', quote: text }
  const point = x != null && y != null ? { x, y } : undefined
  if (timestamp != null) return { kind: 'time', seconds: timestamp, point }
  if (point) return { kind: 'point', ...point }
  return { kind: 'file' }
}
