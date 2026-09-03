import { ArrowDownToLine } from 'lucide-react'
import { buttonVariants } from './button'
import { FileIconTile } from './file-icon-tile'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'

interface FileDeliveryRowProps {
  filePath: string
  agentSlug: string
  /** Agent-supplied blurb from the deliver_file call; falls back to the workspace path. */
  description?: string
  /** Byte size reported by the deliver_file result, when known. */
  sizeBytes?: number
  className?: string
}

function isFolder(filePath: string): boolean {
  return filePath.endsWith('/')
}

function getDisplayName(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  return trimmed.split('/').pop() || filePath
}

/** Path relative to the workspace root, shown when the agent gave no description. */
function getRelativePath(filePath: string): string {
  return filePath.replace(/^\/workspace\/?/, '').replace(/\/+$/, '')
}

/**
 * Full-width row for a file the agent delivered in a turn. The whole row opens
 * the preview tray; the trailing Download button fetches the raw file. Folders
 * open the folder browser and have no download action.
 */
export function FileDeliveryRow({ filePath, agentSlug, description, sizeBytes, className }: FileDeliveryRowProps) {
  const filePreview = useFilePreview()
  const folder = isFolder(filePath)
  const displayName = getDisplayName(filePath)
  const relativePath = getRelativePath(filePath)
  const detail = description?.trim() || (relativePath !== displayName ? relativePath : null)
  const metadata = [detail, sizeBytes !== undefined ? formatFileSize(sizeBytes) : null].filter(Boolean)
  const downloadUrl = folder ? null : `${getApiBaseUrl()}${getAgentFileApiPath(agentSlug, filePath)}`

  const open = () => {
    if (folder) filePreview.openFolder(filePath, agentSlug)
    else filePreview.openFile(filePath, agentSlug, description)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left cursor-pointer',
        'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors',
        className,
      )}
      data-testid="file-delivery-row"
      data-file-name={displayName}
      data-file-path={filePath}
    >
      <FileIconTile filename={displayName} folder={folder} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{displayName}</div>
        {metadata.length > 0 && (
          <div className="truncate text-xs font-normal text-muted-foreground" data-testid="file-delivery-meta">
            {metadata.join(' · ')}
          </div>
        )}
      </div>
      {downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${displayName}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'shrink-0')}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          Download
        </a>
      )}
    </div>
  )
}
