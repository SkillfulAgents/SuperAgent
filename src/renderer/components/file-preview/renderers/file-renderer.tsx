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

const PdfRenderer = lazy(() => import('./pdf-renderer').then(m => ({ default: m.PdfRenderer })))

const MARKDOWN_EXTS = new Set(['md', 'markdown'])
const CSV_EXTS = new Set(['csv', 'tsv'])
const TEXT_EXTS = new Set([
  'txt', 'log', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'env', 'sh', 'bash', 'zsh', 'py', 'js', 'ts', 'tsx', 'jsx', 'css',
  'scss', 'less', 'sql', 'graphql', 'proto', 'dockerfile', 'makefile',
  'gitignore', 'editorconfig', 'rs', 'go', 'java', 'kt', 'swift', 'rb', 'php',
  'c', 'cpp', 'h', 'hpp', 'r',
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'])

interface FileRendererProps {
  filePath: string
  fileUrl: string
  agentSlug: string
  pdfPage?: number
  onPdfPageChange?: (page: number) => void
}

export function FileRenderer({
  filePath,
  fileUrl,
  agentSlug,
  pdfPage = 1,
  onPdfPageChange = () => {},
}: FileRendererProps) {
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
  }

  return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} />
}
