import { Download, FolderIcon } from 'lucide-react'
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

function isFolder(filePath: string): boolean {
  return filePath.endsWith('/')
}

function getFolderName(filePath: string): string {
  // "/workspace/uploads/folderName/" → "folderName"
  const trimmed = filePath.replace(/\/+$/, '')
  return trimmed.split('/').pop() || filePath
}

export function FileDownloadPill({ filePath, agentSlug, onClick }: FileDownloadPillProps) {
  const baseUrl = getApiBaseUrl()
  const folder = isFolder(filePath)
  const displayName = folder ? getFolderName(filePath) : getFilename(filePath)
  const downloadUrl = folder
    ? undefined
    : `${baseUrl}/api/agents/${agentSlug}/files/${getRelativePath(filePath)}`

  const className = "file-pill inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted"

  if (folder) {
    return (
      <span className={className}>
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        {displayName}
      </span>
    )
  }

  return (
    <a
      href={downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={className}
    >
      <FileTypeIcon filename={displayName} size={14} />
      {displayName}
      <Download className="h-3 w-3 download-icon" />
    </a>
  )
}
