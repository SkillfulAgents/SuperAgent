import { X, FolderIcon, Link2, Check, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  if (status === 'done') {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Check className="h-3 w-3 text-emerald-500" data-testid="attachment-done" />
        {sizeText || null}
      </span>
    )
  }
  return sizeText ? <span className="text-muted-foreground">{sizeText}</span> : null
}

export function AttachmentPreview({ attachments, onRemove, onRetry }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cn(
            'flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5 text-xs',
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
                <FolderIcon className="h-4 w-4 text-muted-foreground" />
                <Link2 className="h-2.5 w-2.5 absolute -bottom-0.5 -right-0.5 text-blue-500" />
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
              <FolderIcon className="h-4 w-4 text-muted-foreground" />
              <div className="flex flex-col min-w-0">
                <span className="truncate max-w-[160px] font-medium" title={attachment.folderName}>
                  {attachment.folderName}
                </span>
                <UploadMeta attachment={attachment} sizeText={folderSizeText(attachment)} onRetry={onRetry} />
              </div>
            </>
          ) : (
            <>
              {attachment.file.type.startsWith('image/') && attachment.preview ? (
                <img
                  src={attachment.preview}
                  alt={attachment.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <FileTypeIcon filename={attachment.file.name} size={24} />
              )}
              <div className="flex flex-col min-w-0">
                <span className="truncate max-w-[160px] font-medium" title={attachment.file.name}>
                  {attachment.file.name}
                </span>
                <UploadMeta attachment={attachment} sizeText={formatFileSize(attachment.file.size)} onRetry={onRetry} />
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="ml-1 rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
            data-testid="attachment-remove"
            data-attachment-name={attachmentName(attachment)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
