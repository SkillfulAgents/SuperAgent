import { useEffect, useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { encodeWorkspaceFilePath } from '@renderer/lib/workspace-file-url'
import { LAZY_FALLBACK } from './file-renderer'
import { PdfRenderer } from './pdf-renderer'
import { UnsupportedRenderer } from './unsupported-renderer'

const REASONS: Record<string, string> = {
  timeout: 'Took too long to preview.',
  unreadable: "Can't read this file.",
  forbidden: "You don't have permission to preview this deck.",
}
// The agent could not start or the cloud workspace is not ready: neither is the file type.
const FAILED = "Couldn't preview this deck."

type Pdf = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed'; reason?: string }

interface SlidesRendererProps {
  filePath: string
  agentSlug: string
  downloadUrl?: string
  pageNumber: number
  onPageChange: (page: number) => void
}

/** A deck, converted to PDF in the agent's container and shown with the PDF viewer. */
export function SlidesRenderer({ filePath, agentSlug, downloadUrl, pageNumber, onPageChange }: SlidesRendererProps) {
  const pdf = useDeckPdf(agentSlug, filePath)

  if (!agentSlug) return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} downloadUrl={downloadUrl} />
  if (pdf.status === 'loading') return LAZY_FALLBACK
  if (pdf.status === 'failed') {
    return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} reason={REASONS[pdf.reason ?? ''] ?? FAILED} />
  }
  return (
    <PdfRenderer
      url={pdf.url}
      filePath={filePath}
      agentSlug={agentSlug}
      pageNumber={pageNumber}
      onPageChange={onPageChange}
      partLabel="Slide"
    />
  )
}

function useDeckPdf(agentSlug: string, filePath: string): Pdf {
  const [pdf, setPdf] = useState<Pdf>({ status: 'loading' })

  useEffect(() => {
    if (!agentSlug) return
    const controller = new AbortController()
    let url: string | null = null
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(agentSlug)}/files-pdf/${encodeWorkspaceFilePath(filePath)}`,
          { method: 'POST', signal: controller.signal },
        )
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null)
          const reason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string' ? body.reason : undefined
          setPdf({ status: 'failed', reason: res.status === 403 ? 'forbidden' : reason })
          return
        }
        const blob = await res.blob()
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setPdf({ status: 'ready', url })
      } catch {
        if (!controller.signal.aborted) setPdf({ status: 'failed' })
      }
    })()
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [agentSlug, filePath])

  return pdf
}
