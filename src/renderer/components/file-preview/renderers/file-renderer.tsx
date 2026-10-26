import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { MarkdownRenderer } from './markdown-renderer'
import { TextRenderer } from './text-renderer'
import { CsvRenderer } from './csv-renderer'
import { ImageRenderer } from './image-renderer'
import { VideoRenderer } from './video-renderer'
import { AudioRenderer } from './audio-renderer'
import { HtmlRenderer } from './html-renderer'
import { UnsupportedRenderer } from './unsupported-renderer'
import { previewKind } from '@renderer/lib/file-types'
import { lazyWithReload } from '@renderer/lib/lazy-with-reload'

const PdfRenderer = lazyWithReload(() => import('./pdf-renderer').then(m => ({ default: m.PdfRenderer })))
const ArchiveRenderer = lazyWithReload(() => import('./archive-renderer').then(m => ({ default: m.ArchiveRenderer })))

export const LAZY_FALLBACK = (
  <div className="flex items-center justify-center py-12">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
)

interface FileRendererProps {
  filePath: string
  fileUrl: string
  agentSlug?: string
  downloadUrl?: string
  pdfPage: number
  onPdfPageChange: (page: number) => void
}

export function FileRenderer({
  filePath,
  fileUrl,
  agentSlug = '',
  downloadUrl,
  pdfPage,
  onPdfPageChange,
}: FileRendererProps) {
  switch (previewKind(filePath)) {
    case 'markdown':
      return <MarkdownRenderer key={filePath} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'html':
      return <HtmlRenderer url={fileUrl} />

    case 'csv':
      return <CsvRenderer key={filePath} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'text':
      return <TextRenderer key={filePath} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'image':
      return <ImageRenderer key={filePath} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'video':
      return <VideoRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'audio':
      return <AudioRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} agentSlug={agentSlug} />

    case 'pdf':
      return (
        <Suspense fallback={LAZY_FALLBACK}>
          <PdfRenderer
            key={`${filePath}:${fileUrl}`}
            url={fileUrl}
            filePath={filePath}
            agentSlug={agentSlug}
            pageNumber={pdfPage}
            onPageChange={onPdfPageChange}
          />
        </Suspense>
      )

    case 'archive':
      return (
        <Suspense fallback={LAZY_FALLBACK}>
          <ArchiveRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} agentSlug={agentSlug} downloadUrl={downloadUrl} />
        </Suspense>
      )

    default:
      return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} downloadUrl={downloadUrl} />
  }
}
