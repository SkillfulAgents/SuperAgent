import { Download } from 'lucide-react'
import { FileTypeIcon } from './file-type-icon'
import { getApiBaseUrl } from '@renderer/lib/env'

interface FileDownloadPillProps {
  filePath: string
  agentSlug: string
  onClick?: (e: React.MouseEvent) => void
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getRelativePath(filePath: string): string {
  return filePath.replace(/^\/workspace\//, '')
}

export function FileDownloadPill({ filePath, agentSlug, onClick }: FileDownloadPillProps) {
  const baseUrl = getApiBaseUrl()
  const downloadUrl = `${baseUrl}/api/agents/${agentSlug}/files/${getRelativePath(filePath)}`

  return (
    <a
      href={downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="file-pill inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
    >
      <FileTypeIcon filename={getFilename(filePath)} size={14} />
      {getFilename(filePath)}
      <Download className="h-3 w-3 download-icon" />
    </a>
  )
}
