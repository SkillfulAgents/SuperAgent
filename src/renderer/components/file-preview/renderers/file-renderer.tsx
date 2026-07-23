import { Suspense, lazy } from 'react'
import { Loader2 } from 'lucide-react'
import { getFileExtension } from '@shared/lib/utils/mime'
import { MarkdownRenderer } from './markdown-renderer'
import { TextRenderer } from './text-renderer'
import { CsvRenderer } from './csv-renderer'
import { ImageRenderer } from './image-renderer'
import { VideoRenderer } from './video-renderer'
import { AudioRenderer } from './audio-renderer'
import { HtmlRenderer } from './html-renderer'
import { UnsupportedRenderer } from './unsupported-renderer'
import { useFilePreview } from '@renderer/context/file-preview-context'
import {
  AUDIO_EXTS,
  CSV_EXTS,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  TEXT_EXTS,
  VIDEO_EXTS,
} from '../file-types'

const PdfRenderer = lazy(() => import('./pdf-renderer').then(m => ({ default: m.PdfRenderer })))

interface FileRendererProps {
  filePath: string
  fileUrl: string
  agentSlug: string
}

export function FileRenderer({ filePath, fileUrl, agentSlug }: FileRendererProps) {
  const ext = getFileExtension(filePath)
  const { commentsEnabled } = useFilePreview()

  if (MARKDOWN_EXTS.has(ext)) {
    return <MarkdownRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (ext === 'html' || ext === 'htm') {
    return <HtmlRenderer url={fileUrl} />
  }

  if (CSV_EXTS.has(ext)) {
    return <CsvRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (TEXT_EXTS.has(ext)) {
    return <TextRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (IMAGE_EXTS.has(ext)) {
    return <ImageRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (VIDEO_EXTS.has(ext)) {
    return <VideoRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (AUDIO_EXTS.has(ext)) {
    return <AudioRenderer key={`${filePath}:${fileUrl}`} url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
  }

  if (ext === 'pdf') {
    return (
      <Suspense fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }>
        <PdfRenderer url={fileUrl} filePath={filePath} commentsEnabled={commentsEnabled} />
      </Suspense>
    )
  }

  return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} />
}
