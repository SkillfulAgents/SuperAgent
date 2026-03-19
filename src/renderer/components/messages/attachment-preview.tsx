import { X, FolderIcon, Link2 } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'

export interface FileAttachment {
  type: 'file'
  id: string
  file: File
  preview?: string
}

export interface FolderAttachment {
  type: 'folder'
  id: string
  folderName: string
  folderPath?: string
  files: { file: File; relativePath: string }[]
  totalSize: number
}

export interface MountAttachment {
  type: 'mount'
  id: string
  folderName: string
  hostPath: string
}

export type Attachment = FileAttachment | FolderAttachment | MountAttachment

interface AttachmentPreviewProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
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
                <span className="text-muted-foreground">mounted, read-write</span>
              </div>
            </>
          ) : attachment.type === 'folder' ? (
            <>
              <FolderIcon className="h-4 w-4 text-muted-foreground" />
              <div className="flex flex-col min-w-0">
                <span className="truncate max-w-[160px] font-medium" title={attachment.folderName}>
                  {attachment.folderName}
                </span>
                {attachment.files.length > 0 && (
                  <span className="text-muted-foreground">
                    {attachment.files.length} file{attachment.files.length !== 1 ? 's' : ''} &middot; {formatFileSize(attachment.totalSize)}
                  </span>
                )}
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
                <span className="text-muted-foreground">
                  {formatFileSize(attachment.file.size)}
                </span>
              </div>
            </>
          )}
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
