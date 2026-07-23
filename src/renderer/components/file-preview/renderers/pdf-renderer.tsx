import { useState, useRef, useEffect, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ChevronLeft, ChevronRight, Loader2, AlertCircle } from 'lucide-react'
import { useTextSelection } from '../comments/use-text-selection'
import { CommentOverlay } from '../comments/comment-overlay'

import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

try {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
} catch {
  // Fallback for environments where URL construction fails
}

interface PdfRendererProps {
  url: string
  filePath: string
  pageNumber: number
  onPageChange: (page: number) => void
  commentsEnabled?: boolean
}

export function PdfRenderer({
  url,
  filePath,
  pageNumber,
  onPageChange,
  commentsEnabled = true,
}: PdfRendererProps) {
  const [numPages, setNumPages] = useState<number | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pageWidth, setPageWidth] = useState(400)
  const containerRef = useRef<HTMLDivElement>(null)
  const { selection, clearSelection } = useTextSelection(containerRef, commentsEnabled)

  const updateWidth = useCallback(() => {
    if (containerRef.current) {
      setPageWidth(containerRef.current.clientWidth - 32)
    }
  }, [])

  useEffect(() => {
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [updateWidth])

  const currentPage = numPages === null
    ? null
    : Math.max(1, Math.min(pageNumber, numPages))

  const handleLoadSuccess = ({ numPages: loadedPages }: { numPages: number }) => {
    setNumPages(loadedPages)
    setLoadError(false)
    if (pageNumber > loadedPages) onPageChange(loadedPages)
  }

  return (
    <div ref={containerRef} className="relative flex flex-col items-center">
      <Document
        file={url}
        onLoadSuccess={handleLoadSuccess}
        onLoadError={() => setLoadError(true)}
        loading={
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }
        error={
          <div className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Failed to load PDF</span>
          </div>
        }
      >
        {!loadError && currentPage !== null && (
          <Page
            pageNumber={currentPage}
            width={pageWidth}
            renderTextLayer={true}
            renderAnnotationLayer={true}
            className="mx-auto"
          />
        )}
      </Document>

      {numPages && numPages > 1 && currentPage !== null && (
        <div
          data-testid="pdf-pagination"
          className="sticky bottom-0 z-10 flex items-center gap-2 py-2 px-3 bg-background/90 backdrop-blur-sm border-t border-border/40 w-full justify-center"
        >
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            aria-label="Previous PDF page"
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentPage} / {numPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
            aria-label="Next PDF page"
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {selection && (
        <CommentOverlay
          selection={selection}
          filePath={filePath}
          onClose={clearSelection}
        />
      )}
    </div>
  )
}
