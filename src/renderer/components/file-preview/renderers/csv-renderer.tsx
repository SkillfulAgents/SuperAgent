import { Loader2, AlertCircle, Table2, FileText } from 'lucide-react'
import { memo, useMemo, useRef, useState, useCallback } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { parseCsv } from './csv-parse'
import { TextRenderer } from './text-renderer'
import { useFileContent } from './use-file-content'
import { CommentOverlay } from '../comments/comment-overlay'
import { useDismissOnOutsideClick } from '../comments/use-dismiss-on-outside-click'
import { useFilePreview } from '@renderer/context/file-preview-context'

interface CsvRendererProps {
  url: string
  filePath: string
  commentsEnabled?: boolean
}

const MAX_ROWS = 1000
const CSV_DISMISS_IGNORE = ['[data-comment-overlay]', '[data-csv-cell]']

interface CellTarget {
  row: number // 1-based data row
  col: number // 0-based column index
  column: string // column label
  value: string
  rect: DOMRect // relative to the container
}

type CellClickHandler = (e: React.MouseEvent, row: number, col: number, column: string, value: string) => void

interface CsvTableProps {
  rows: string[][]
  columnLabels: string[]
  /** "row:col" -> 1-based comment numbers pinned to that cell. */
  commentsByCell: Map<string, number[]>
  onCellClick: CellClickHandler
  commentsEnabled: boolean
}

/**
 * The grid itself, memoized so opening/closing the comment overlay (parent
 * `cellTarget` state) doesn't re-render up to MAX_ROWS × columns of cells.
 * Only re-renders when the data or pinned comments actually change.
 */
const CsvTable = memo(function CsvTable({ rows, columnLabels, commentsByCell, onCellClick, commentsEnabled }: CsvTableProps) {
  return (
    <table className="border-collapse text-xs font-mono">
      <thead>
        <tr>
          <th className="sticky top-0 left-0 z-20 bg-muted px-2 py-1 text-right text-muted-foreground/60 font-normal select-none border-b border-r border-border/40 w-[1%]">
            #
          </th>
          {columnLabels.map((label, c) => (
            <th
              key={c}
              className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-semibold whitespace-nowrap border-b border-r border-border/40"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => {
          const rowNum = r + 1
          return (
            <tr key={r} className="hover:bg-muted/20">
              <td className="sticky left-0 z-10 bg-background px-2 py-1 text-right text-muted-foreground/50 select-none align-top tabular-nums border-b border-r border-border/30 w-[1%]">
                {rowNum}
              </td>
              {row.map((value, c) => {
                const cellComments = commentsByCell.get(`${rowNum}:${c}`)
                return (
                  <td
                    key={c}
                    data-csv-cell
                    onClick={commentsEnabled ? (e) => onCellClick(e, rowNum, c, columnLabels[c], value) : undefined}
                    className={cn(
                      'relative px-3 py-1 align-top whitespace-pre-wrap break-words max-w-[28rem] border-b border-r border-border/30',
                      commentsEnabled && 'cursor-pointer hover:bg-primary/5',
                      cellComments && 'bg-primary/10',
                    )}
                  >
                    {value}
                    {cellComments && (
                      <span
                        className="absolute top-0.5 right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-[0.875rem] text-center shadow-sm pointer-events-none"
                        title={`${cellComments.length} comment${cellComments.length === 1 ? '' : 's'}`}
                      >
                        {cellComments.length}
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
})

export function CsvRenderer({ url, filePath, commentsEnabled = true }: CsvRendererProps) {
  const [view, setView] = useState<'table' | 'raw'>('table')
  const [cellTarget, setCellTarget] = useState<CellTarget | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { comments } = useFilePreview()

  // The context Map preserves untouched per-file arrays across unrelated
  // mutations, so keying the memo on this file's array (not the whole Map)
  // keeps the table from re-rendering when another file's comments change.
  const fileComments = comments.get(filePath)
  const commentsByCell = useMemo(() => {
    const map = new Map<string, number[]>()
    fileComments?.forEach((c, i) => {
      if (c.cell) {
        const key = `${c.cell.row}:${c.cell.col}`
        const list = map.get(key)
        if (list) list.push(i + 1)
        else map.set(key, [i + 1])
      }
    })
    return map
  }, [fileComments])

  const { data, isLoading, error } = useFileContent(url)
  const sizeTruncated = data?.truncated ?? false

  const parsed = useMemo(() => {
    if (!data) return null
    const result = parseCsv(data.text)
    // A size-truncated file is sliced mid-stream, so the final parsed row is
    // very likely a partial/garbled record (or a runaway unclosed quote). Drop
    // it rather than render a malformed row; the banner explains the omission.
    if (sizeTruncated && result.rows.length > 0) {
      return { ...result, rows: result.rows.slice(0, -1) }
    }
    return result
  }, [data, sizeTruncated])

  const columnLabels = useMemo(
    () => (parsed ? parsed.headers.map((h, i) => h.trim() || `Column ${i + 1}`) : []),
    [parsed],
  )

  const rowCount = parsed?.rows.length ?? 0
  const rowsTruncated = rowCount > MAX_ROWS
  const visibleRows = useMemo(
    () => (parsed ? (rowsTruncated ? parsed.rows.slice(0, MAX_ROWS) : parsed.rows) : []),
    [parsed, rowsTruncated],
  )

  useDismissOnOutsideClick(cellTarget != null, () => setCellTarget(null), CSV_DISMISS_IGNORE)

  const handleCellClick = useCallback<CellClickHandler>((e, row, col, column, value) => {
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    setCellTarget({
      row,
      col,
      column,
      value,
      rect: new DOMRect(e.clientX - containerRect.left, e.clientY - containerRect.top, 0, 0),
    })
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load file</span>
      </div>
    )
  }

  if (!parsed || parsed.headers.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">This file is empty.</div>
  }

  return (
    <div ref={containerRef} className="relative" data-testid="csv-renderer">
      {/* Toolbar: dimensions + table/raw toggle */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground border-b border-border/40">
        <span className="tabular-nums">
          {parsed.columnCount} {parsed.columnCount === 1 ? 'column' : 'columns'} ·{' '}
          {rowCount.toLocaleString()} {rowCount === 1 ? 'row' : 'rows'}
        </span>
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          <button
            onClick={() => setView('table')}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
              view === 'table' ? 'bg-muted text-foreground' : 'hover:bg-muted/50',
            )}
            title="Table view"
          >
            <Table2 className="h-3 w-3" />
            Table
          </button>
          <button
            onClick={() => setView('raw')}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
              view === 'raw' ? 'bg-muted text-foreground' : 'hover:bg-muted/50',
            )}
            title="Raw text view"
          >
            <FileText className="h-3 w-3" />
            Raw
          </button>
        </div>
      </div>

      {view === 'raw' ? (
        <TextRenderer url={url} filePath={filePath} commentsEnabled={commentsEnabled} />
      ) : (
        <>
          <CsvTable
            rows={visibleRows}
            columnLabels={columnLabels}
            commentsByCell={commentsByCell}
            onCellClick={handleCellClick}
            commentsEnabled={commentsEnabled}
          />
          {sizeTruncated && (
            <div className="px-4 py-3 border-t text-xs text-muted-foreground text-center">
              File is larger than 5&nbsp;MB and was truncated before parsing &mdash; later rows are missing. Download the
              file for the full content.
            </div>
          )}
          {rowsTruncated && (
            <div className="px-4 py-3 border-t text-xs text-muted-foreground text-center">
              Showing first {MAX_ROWS.toLocaleString()} of {rowCount.toLocaleString()} rows. Switch to Raw or download the
              file for the full content.
            </div>
          )}
        </>
      )}

      {commentsEnabled && cellTarget && (
        <CommentOverlay
          selection={{
            text: '',
            rect: cellTarget.rect,
            cell: {
              row: cellTarget.row,
              col: cellTarget.col,
              column: cellTarget.column,
              value: cellTarget.value,
            },
          }}
          filePath={filePath}
          onClose={() => setCellTarget(null)}
        />
      )}
    </div>
  )
}
