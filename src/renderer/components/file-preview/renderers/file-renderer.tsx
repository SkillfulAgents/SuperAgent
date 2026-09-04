import { Suspense, lazy } from 'react'
import { Loader2 } from 'lucide-react'
import { MarkdownRenderer } from './markdown-renderer'
import { TextRenderer } from './text-renderer'
import { CsvRenderer } from './csv-renderer'
import { ImageRenderer } from './image-renderer'
import { VideoRenderer } from './video-renderer'
import { AudioRenderer } from './audio-renderer'
import { HtmlRenderer } from './html-renderer'
import { UnsupportedRenderer } from './unsupported-renderer'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { previewKind } from '../file-types'

const PdfRenderer = lazy(() => import('./pdf-renderer').then(m => ({ default: m.PdfRenderer })))

interface FileRendererProps {
  filePath: string
  fileUrl: string
  agentSlug: string
  pdfPage: number
  onPdfPageChange: (page: number) => void
}

export function FileRenderer({
  filePath,
  fileUrl,
  agentSlug,
  pdfPage,
  onPdfPageChange,
}: FileRendererProps) {
  const { commentsEnabled } = useFilePreview()

  switch (previewKind(filePath)) {
    case 'markdown':
      return <MarkdownRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'html':
      return <HtmlRenderer url={fileUrl} />

    case 'csv':
      return <CsvRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'text':
      return <TextRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'image':
      return <ImageRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'video':
      return <VideoRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'audio':
      return <AudioRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />

    case 'pdf':
      return (
        <Suspense fallback={
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        }>
          <PdfRenderer
            key={`${filePath}:${fileUrl}`}
            url={fileUrl}
            filePath={filePath}
            pageNumber={pdfPage}
            onPageChange={onPdfPageChange}
            commentsEnabled={commentsEnabled}
          />
        </Suspense>
      )

    default:
      return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} />
  }
}
