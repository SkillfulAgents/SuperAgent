import { FileIconTile } from '@renderer/components/ui/file-icon-tile'
import { IMAGE_EXTS } from '@renderer/components/file-preview/file-types'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useFileSize } from '@renderer/hooks/use-file-size'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { getFileExtension } from '@shared/lib/utils/mime'
import { displayNameForPath } from '@shared/lib/utils/upload-display-name'

interface SentAttachmentChipProps {
  filePath: string
  agentSlug: string
  /**
   * How an image is sized. `single` (default) shows it at native aspect under a
   * 256px cap — up to three images stack this way; `grid` is a square tile
   * (cropped to fit) for the 3-column grid used when a message carries more.
   */
  imageSize?: ImageSize
}

export type ImageSize = 'single' | 'grid'

/** Pick the image treatment for a message from how many images it carries. */
export function imageSizeForCount(count: number): ImageSize {
  return count > 3 ? 'grid' : 'single'
}

/** True for paths the sent-message layout should show as pictures rather than chips. */
export function isImageAttachment(filePath: string): boolean {
  return !filePath.endsWith('/') && IMAGE_EXTS.has(getFileExtension(filePath))
}

/**
 * An attachment on a sent user message, drawn the same way the composer drew
 * it before send, except images, which show the picture itself at native
 * aspect ratio (height-capped); everything else is the icon tile with the
 * name and size. Clicking opens the file (or folder) in the
 * preview drawer. Unlike the composer chip there is no remove control.
 */
export function SentAttachmentChip({ filePath, agentSlug, imageSize = 'single' }: SentAttachmentChipProps) {
  const filePreview = useFilePreview()
  const folder = filePath.endsWith('/')
  const name = displayNameForPath(filePath)
  const image = isImageAttachment(filePath)
  const fileApiPath = folder ? null : getAgentFileApiPath(agentSlug, filePath)
  const { data: sizeBytes } = useFileSize(fileApiPath)
  const sizeText = typeof sizeBytes === 'number' ? formatFileSize(sizeBytes) : null

  const open = () => {
    if (folder) filePreview.openFolder(filePath, agentSlug)
    else filePreview.openFile(filePath, agentSlug)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      className={cn(
        'relative cursor-pointer rounded-md border bg-background text-xs text-left transition-colors',
        'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Sent images show at their own aspect ratio, capped in height so a
        // tall screenshot doesn't take over the thread; width is bounded by the
        // message column.
        image
          ? imageSize === 'grid' ? 'aspect-square w-full overflow-hidden' : 'max-w-full overflow-hidden'
          : 'flex items-center gap-2 py-1.5 pl-2 pr-3',
      )}
      title={image && sizeText ? `${name} · ${sizeText}` : undefined}
      data-testid="file-pill"
      data-file-name={name}
      data-file-path={filePath}
      data-attachment-kind={folder ? 'folder' : image ? 'image' : 'file'}
      data-image-size={image ? imageSize : undefined}
    >
      {image ? (
        <>
          <img
            src={`${getApiBaseUrl()}${fileApiPath}?inline=true`}
            alt={name}
            className={cn(
              'block',
              imageSize === 'grid' ? 'h-full w-full object-cover' : 'h-auto max-h-64 w-auto max-w-full',
            )}
          />
          {/* Name for assistive tech and text-based lookups; the square itself is picture-only. */}
          <span className="sr-only">{name}</span>
        </>
      ) : (
        <>
          <FileIconTile filename={name} folder={folder} />
          <div className="flex min-w-0 flex-col">
            <span className="max-w-[160px] truncate font-medium" title={name}>{name}</span>
            {sizeText && <span className="text-muted-foreground">{sizeText}</span>}
          </div>
        </>
      )}
    </div>
  )
}
