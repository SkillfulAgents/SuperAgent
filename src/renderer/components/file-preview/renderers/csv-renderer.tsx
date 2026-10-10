import { Loader2, AlertCircle, Table2, FileText } from 'lucide-react'
import { memo, useMemo, useRef, useState, useCallback } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { parseCsv } from './csv-parse'
import { TextRenderer } from './text-renderer'
import { useFileContent } from './use-file-content'
import { useCommentBox } from '../comments/use-comment-box'
import type { CellRef } from '../comments/kinds'
import { useFilePreview } from '@renderer/context/file-preview-context'

interface CsvRendererProps {
  url: string
  filePath: string
  agentSlug: string
}

const MAX_ROWS = 1000

interface CsvTableProps {
  rows: string[][]
  columnLabels: string[]
  commentsEnabled: boolean
}

/**
 * The grid itself, memoized so opening and closing a comment doesn't re-render
 * up to MAX_ROWS × columns of cells. Comment markers are drawn into the cells.
 */
const CsvTable = memo(function CsvTable({ rows, columnLabels, commentsEnabled }: CsvTableProps) {
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
              className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-r border-border/40"
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
              {row.map((value, c) => (
                <td
                  key={c}
                  data-comment-cell={`${rowNum}:${c}`}
                  className={cn(
                    'relative px-3 py-1 align-top whitespace-pre-wrap break-words max-w-[28rem] border-b border-r border-border/30',
                    commentsEnabled && 'cursor-pointer hover:bg-primary/5',
                  )}
                >
                  {value}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
})

export function CsvRenderer({ url, filePath, agentSlug }: CsvRendererProps) {
  const [view, setView] = useState<'table' | 'raw'>('table')
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const { commentsEnabled } = useFilePreview()

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

  const cellAt = useCallback((row: number, col: number): CellRef | undefined => {
    const value = visibleRows[row - 1]?.[col]
    return value === undefined ? undefined : { row, col, column: columnLabels[col], value }
  }, [visibleRows, columnLabels])
  // Raw view hands comments to the nested text viewer.
  const surface = useMemo(() => (view === 'table' ? { cell: { grid: gridRef, cellAt } } : null), [view, cellAt])
  const { box, enabled } = useCommentBox(containerRef, surface, filePath, agentSlug)

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
        <TextRenderer url={url} filePath={filePath} agentSlug={agentSlug} commentsEnabled={commentsEnabled} />
      ) : (
        <>
          <div ref={gridRef}>
            <CsvTable rows={visibleRows} columnLabels={columnLabels} commentsEnabled={enabled} />
          </div>
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

      {box}
    </div>
  )
}
