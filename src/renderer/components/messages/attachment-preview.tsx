import { X, FileIcon, ImageIcon } from 'lucide-react'

export interface Attachment {
  file: File
  id: string
  preview?: string
}

interface AttachmentPreviewProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5 text-xs"
        >
          {isImageFile(attachment.file) && attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.file.name}
              className="h-8 w-8 rounded object-cover"
            />
          ) : isImageFile(attachment.file) ? (
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          ) : (
            <FileIcon className="h-4 w-4 text-muted-foreground" />
          )}
          <div className="flex flex-col min-w-0">
            <span className="truncate max-w-[120px] font-medium">
              {attachment.file.name}
            </span>
            <span className="text-muted-foreground">
              {formatFileSize(attachment.file.size)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="ml-1 rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
