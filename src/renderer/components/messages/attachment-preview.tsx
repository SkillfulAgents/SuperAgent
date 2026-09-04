import { X, Link2, AlertTriangle, Clock, Loader2, RotateCw } from 'lucide-react'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { cn } from '@shared/lib/utils'
import { FileIconTile } from '@renderer/components/ui/file-icon-tile'
import { isPreviewableImage } from '@renderer/components/file-preview/file-types'
import { Progress } from '@renderer/components/ui/progress'

export interface UploadState {
  status: 'queued' | 'uploading' | 'done'
  /** Bytes-sent percent. Absent when there is no byte progress (folder copy, zipping). */
  percent?: number
  /** Workspace path returned by the server, once done. */
  path?: string
  /** Which agent workspace holds the file; a different agent must re-upload. */
  agentSlug: string
}

export interface FileAttachment {
  type: 'file'
  id: string
  file: File
  preview?: string
  /** Set when uploading this attachment failed; renders the chip in an error state. */
  error?: string
  upload?: UploadState
}

export interface FolderAttachment {
  type: 'folder'
  id: string
  folderName: string
  folderPath?: string
  files: { file: File; relativePath: string }[]
  totalSize: number
  /** Set when uploading this attachment failed; renders the chip in an error state. */
  error?: string
  upload?: UploadState
}

export interface MountAttachment {
  type: 'mount'
  id: string
  folderName: string
  hostPath: string
  /** Set when submitting this attachment failed; renders the chip in an error state. */
  error?: string
}

export type Attachment = FileAttachment | FolderAttachment | MountAttachment

export type AttachmentStatus = 'queued' | 'uploading' | 'done' | 'error'

// The one place the two stored fields become a status. `error` wins so a
// failed retry never shows a stale bar.
export function attachmentStatus(a: Attachment): AttachmentStatus | undefined {
  if (a.error) return 'error'
  if (a.type === 'mount') return undefined
  return a.upload?.status
}

interface AttachmentPreviewProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
  onRetry?: (id: string) => void
}

function attachmentName(attachment: Attachment): string {
  return attachment.type === 'file' ? attachment.file.name : attachment.folderName
}

function folderSizeText(attachment: FolderAttachment): string {
  if (attachment.files.length === 0) return ''
  return `${attachment.files.length} file${attachment.files.length !== 1 ? 's' : ''} · ${formatFileSize(attachment.totalSize)}`
}

function UploadMeta({ attachment, sizeText, onRetry }: { attachment: FileAttachment | FolderAttachment; sizeText: string; onRetry?: (id: string) => void }) {
  const status = attachmentStatus(attachment)
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <AlertTriangle className="h-3 w-3 text-amber-500" />
        <span className="truncate max-w-[120px]" title={attachment.error}>upload failed</span>
        {onRetry && (
          <button type="button" onClick={() => onRetry(attachment.id)} className="underline hover:text-foreground" data-testid="attachment-retry">
            retry
          </button>
        )}
      </span>
    )
  }
  if (status === 'queued') return <span className="text-muted-foreground">waiting</span>
  if (status === 'uploading') {
    return attachment.upload?.percent === undefined ? (
      <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />uploading</span>
    ) : (
      <>
        {sizeText ? <span className="text-muted-foreground">{sizeText}</span> : null}
        <div data-testid="attachment-progress">
          <Progress percent={attachment.upload.percent} className="mt-1 w-[120px]" />
        </div>
      </>
    )
  }
  // Done reads the same as queued: the chip's status attribute carries the
  // state for tests, and a finished upload needs no badge — just the size.
  return sizeText ? <span className="text-muted-foreground">{sizeText}</span> : null
}

/**
 * Upload state for the picture-only chip.
 *
 * The text chip carries this on its meta line; a 44px square has no room for
 * one, so the same three things it would have said are drawn over the image
 * instead of dropped: that the upload is still queued, that it is moving and
 * roughly how far along, and that it failed in a way you can retry.
 */
function ImageUploadOverlay({ attachment, onRetry }: { attachment: FileAttachment; onRetry?: (id: string) => void }) {
  const status = attachmentStatus(attachment)

  if (status === 'error') {
    // The whole square is the retry target: a second button beside the remove
    // control, inside 44px, would be too small to aim at.
    if (!onRetry) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-destructive/40" title={attachment.error}>
          <AlertTriangle className="h-4 w-4 text-destructive-foreground" />
        </div>
      )
    }
    return (
      <button
        type="button"
        onClick={() => onRetry(attachment.id)}
        className="absolute inset-0 flex items-center justify-center bg-destructive/40 transition-colors hover:bg-destructive/60"
        title={`${attachment.error ?? 'Upload failed'} — click to retry`}
        aria-label={`Retry upload of ${attachment.file.name}`}
        data-testid="attachment-retry"
      >
        <RotateCw className="h-4 w-4 text-destructive-foreground" />
      </button>
    )
  }

  if (status === 'queued') {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-background/60"
        title="Waiting to upload"
        data-testid="attachment-queued"
      >
        <Clock className="h-4 w-4 text-muted-foreground" />
      </div>
    )
  }

  if (status === 'uploading') {
    const percent = attachment.upload?.percent
    if (percent === undefined) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60" data-testid="attachment-progress">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )
    }
    // The same bar the text chip draws, pinned to the bottom edge over a dimmed
    // picture. A bar this narrow cannot report a figure and does not need to —
    // what it has to show is that the upload is moving.
    return (
      <div className="absolute inset-0 flex items-end bg-background/40" data-testid="attachment-progress">
        <Progress percent={percent} className="m-1" />
      </div>
    )
  }

  return null
}

export function AttachmentPreview({ attachments, onRemove, onRetry }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        // Images with a preview are just the picture: a square chip, full bleed,
        // no name or size. Everything else is the icon-tile-plus-text chip.
        const imageChip = attachment.type === 'file' && !!attachment.preview && isPreviewableImage(attachment.file.name)
        return (
        <div
          key={attachment.id}
          className={cn(
            'relative rounded-md border bg-background text-xs',
            imageChip
              ? 'h-11 w-11 shrink-0 overflow-hidden'
              : 'flex items-center gap-2 py-1.5 pl-2 pr-7',
            attachment.error && 'border-destructive/50 bg-destructive/10'
          )}
          data-testid="attachment-preview"
          data-attachment-name={attachmentName(attachment)}
          data-attachment-type={attachment.type}
          data-attachment-error={attachment.error || undefined}
          data-attachment-status={attachmentStatus(attachment)}
        >
          {attachment.type === 'mount' ? (
            <>
              <div className="relative">
                <FileIconTile filename={attachment.folderName} folder />
                <Link2 className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-background text-blue-500" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="truncate max-w-[160px] font-medium" title={attachment.folderName}>
                  {attachment.folderName}
                </span>
                {attachment.error ? (
                  <span className="text-destructive truncate max-w-[160px]" title={attachment.error}>
                    mount failed
                  </span>
                ) : (
                  <span className="text-muted-foreground">mounted, read-write</span>
                )}
              </div>
            </>
          ) : attachment.type === 'folder' ? (
            <>
              <FileIconTile filename={attachment.folderName} folder />
              <div className="flex flex-col min-w-0">
                <span className="truncate max-w-[160px] font-medium" title={attachment.folderName}>
                  {attachment.folderName}
                </span>
                <UploadMeta attachment={attachment} sizeText={folderSizeText(attachment)} onRetry={onRetry} />
              </div>
            </>
          ) : (
            <>
              {imageChip ? (
                <>
                  <img
                    src={attachment.preview}
                    alt={attachment.file.name}
                    title={`${attachment.file.name} · ${formatFileSize(attachment.file.size)}`}
                    className="h-full w-full object-cover"
                  />
                  <ImageUploadOverlay attachment={attachment} onRetry={onRetry} />
                </>
              ) : (
                <>
                  <FileIconTile filename={attachment.file.name} />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate max-w-[160px] font-medium" title={attachment.file.name}>
                      {attachment.file.name}
                    </span>
                    <UploadMeta attachment={attachment} sizeText={formatFileSize(attachment.file.size)} onRetry={onRetry} />
                  </div>
                </>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className={cn(
              // Always visible on a gray circle, so it's discoverable without hover
              // and stays legible over an image.
              'absolute rounded-full bg-muted p-0.5 text-foreground transition-colors hover:bg-muted-foreground/20',
              // Over a picture the gray circle can land on gray pixels; a
              // background-coloured ring keeps its edge no matter what is behind it.
              imageChip ? 'right-0.5 top-0.5 ring-1 ring-background' : 'right-1 top-1',
            )}
            aria-label={`Remove ${attachmentName(attachment)}`}
            data-testid="attachment-remove"
            data-attachment-name={attachmentName(attachment)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        )
      })}
    </div>
  )
}
