import { Suspense, lazy } from 'react'
import { Loader2 } from 'lucide-react'
import { getFileExtension } from '@shared/lib/utils/mime'
import { MarkdownRenderer } from './markdown-renderer'
import { TextRenderer } from './text-renderer'
import { CsvRenderer } from './csv-renderer'
import { ImageRenderer } from './image-renderer'
import { VideoRenderer } from './video-renderer'
import { HtmlRenderer } from './html-renderer'
import { UnsupportedRenderer } from './unsupported-renderer'

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

interface FileRendererProps {
  filePath: string
  fileUrl: string
  agentSlug: string
}

export function FileRenderer({ filePath, fileUrl, agentSlug }: FileRendererProps) {
  const ext = getFileExtension(filePath)

  if (MARKDOWN_EXTS.has(ext)) {
    return <MarkdownRenderer url={fileUrl} filePath={filePath} />
  }

  if (ext === 'html' || ext === 'htm') {
    return <HtmlRenderer url={fileUrl} />
  }

  if (CSV_EXTS.has(ext)) {
    return <CsvRenderer url={fileUrl} filePath={filePath} />
  }

  if (TEXT_EXTS.has(ext)) {
    return <TextRenderer url={fileUrl} filePath={filePath} />
  }

  if (IMAGE_EXTS.has(ext)) {
    return <ImageRenderer url={fileUrl} filePath={filePath} />
  }

  if (VIDEO_EXTS.has(ext)) {
    return <VideoRenderer url={fileUrl} filePath={filePath} />
  }

  if (ext === 'pdf') {
    return (
      <Suspense fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }>
        <PdfRenderer url={fileUrl} filePath={filePath} />
      </Suspense>
    )
  }

  return <UnsupportedRenderer filePath={filePath} agentSlug={agentSlug} />
}
