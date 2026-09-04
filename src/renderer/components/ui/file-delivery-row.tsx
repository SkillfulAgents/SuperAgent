import { ArrowDownToLine, ChevronRight } from 'lucide-react'
import { buttonVariants } from './button'
import { FileIconTile } from './file-icon-tile'
import { previewKind } from '@renderer/components/file-preview/file-types'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { getPathName, toWorkspaceRelativePath } from '@shared/lib/utils/workspace-path'

interface FileDeliveryRowProps {
  filePath: string
  agentSlug: string
  /** Agent-supplied blurb from the deliver_file call; falls back to the workspace path. */
  description?: string
  /** Byte size the deliver_file result reported, when known. */
  sizeBytes?: number
  className?: string
}

/**
 * Full-width row for a file the agent delivered in a turn.
 *
 * The whole row opens the preview drawer. What sits at its right end says what
 * that will get you: a chevron when the drawer can render the file, pointing at
 * the panel it opens, and a Download button when it cannot, since for a .xlsx or
 * a .zip saving it is the only thing the user can do with it. Files that preview
 * can still be downloaded from inside the drawer.
 */
export function FileDeliveryRow({ filePath, agentSlug, description, sizeBytes, className }: FileDeliveryRowProps) {
  const filePreview = useFilePreview()
  const displayName = getPathName(filePath)
  const relativePath = toWorkspaceRelativePath(filePath)
  const detail = description?.trim() || (relativePath !== displayName ? relativePath : null)
  const metadata = [detail, sizeBytes !== undefined ? formatFileSize(sizeBytes) : null].filter(Boolean)
  const previewable = previewKind(filePath) !== null

  const open = () => filePreview.openFile(filePath, agentSlug, description)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      // Only the row's own key presses open the preview. Without the target
      // check this also swallows Enter on the Download link inside it, which
      // would cancel the download and open the drawer instead.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left cursor-pointer',
        'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors',
        className,
      )}
      data-testid="file-delivery-row"
      data-file-name={displayName}
      data-file-action={previewable ? 'preview' : 'download'}
    >
      <FileIconTile filename={displayName} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{displayName}</div>
        {metadata.length > 0 && (
          <div className="truncate text-xs font-normal text-muted-foreground" data-testid="file-delivery-meta">
            {metadata.join(' · ')}
          </div>
        )}
      </div>
      {previewable ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
      ) : (
        <a
          href={`${getApiBaseUrl()}${getAgentFileApiPath(agentSlug, filePath)}`}
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
