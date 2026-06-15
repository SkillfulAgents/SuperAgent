import { FolderIcon } from 'lucide-react'
import { FileTypeIcon } from './file-type-icon'
import { useFilePreview } from '@renderer/context/file-preview-context'

interface FileDownloadPillProps {
  filePath: string
  agentSlug: string
  onClick?: (e: React.MouseEvent) => void
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function isFolder(filePath: string): boolean {
  return filePath.endsWith('/')
}

function getFolderName(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  return trimmed.split('/').pop() || filePath
}

export function FileDownloadPill({ filePath, agentSlug, onClick }: FileDownloadPillProps) {
  const filePreview = useFilePreview()
  const folder = isFolder(filePath)
  const displayName = folder ? getFolderName(filePath) : getFilename(filePath)

  const className = "file-pill inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"

  if (folder) {
    return (
      <span
        className={className}
        data-testid="file-pill"
        data-file-name={displayName}
        data-file-path={filePath}
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        {displayName}
      </span>
    )
  }

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onClick?.(e)
    filePreview.openFile(filePath, agentSlug)
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent) } }}
      className={className}
      data-testid="file-pill"
      data-file-name={displayName}
      data-file-path={filePath}
    >
      <FileTypeIcon filename={displayName} size={14} />
      {displayName}
    </span>
  )
}
