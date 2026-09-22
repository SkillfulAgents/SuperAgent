import { ArrowDownToLine, ChevronRight } from 'lucide-react'
import { buttonVariants } from './button'
import { FileIconTile } from './file-icon-tile'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { openableProps } from '@renderer/lib/openable'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'

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
  const { openFile } = useFilePreview()
  const file = describeWorkspaceFile(filePath, agentSlug)
  const detail = description?.trim() || (file.relativePath !== file.name ? file.relativePath : null)
  const metadata = [detail, sizeBytes !== undefined ? formatFileSize(sizeBytes) : null].filter(Boolean)

  return (
    <div
      {...openableProps(() => openFile(file.path, file.agentSlug, description))}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left cursor-pointer',
        'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors',
        className,
      )}
      data-testid="file-delivery-row"
      data-file-name={file.name}
      data-file-action={file.previewable ? 'preview' : 'download'}
    >
      <FileIconTile filename={file.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{file.name}</div>
        {metadata.length > 0 && (
          <div className="truncate text-xs font-normal text-muted-foreground" data-testid="file-delivery-meta">
            {metadata.join(' · ')}
          </div>
        )}
      </div>
      {file.previewable || !file.downloadUrl ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
      ) : (
        <a
          href={file.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          // Opts this link out of the row's activation, for the mouse and — since
          // Enter on a link dispatches a click — for the keyboard too.
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${file.name}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'shrink-0')}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          Download
        </a>
      )}
    </div>
  )
}
