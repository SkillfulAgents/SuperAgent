import { useState } from 'react'
import { FileIconTile } from '@renderer/components/ui/file-icon-tile'
import { isPreviewableImage } from '@renderer/components/file-preview/file-types'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useFileSize } from '@renderer/hooks/use-file-size'
import { getAgentFileApiPath, getAgentFileUrl } from '@renderer/lib/workspace-file-url'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { getPathName } from '@shared/lib/utils/workspace-path'

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

/**
 * An attachment on a sent user message, drawn the same way the composer drew
 * it before send, except images, which show the picture itself at native
 * aspect ratio (height-capped); everything else is the icon tile with the
 * name and size. Clicking opens the file (or folder) in the
 * preview drawer. Unlike the composer chip there is no remove control.
 */
export function SentAttachmentChip({ filePath, agentSlug, imageSize = 'single' }: SentAttachmentChipProps) {
  const filePreview = useFilePreview()
  // A picture that will not load is worse than no picture: an alt-text box, or
  // a blank square in a grid. Falling back to the chip still names the file and
  // still opens it, which is everything the row is for.
  const [imageBroken, setImageBroken] = useState(false)
  const folder = filePath.endsWith('/')
  const name = getPathName(filePath)
  const image = isPreviewableImage(filePath) && !imageBroken
  const fileApiPath = folder ? null : getAgentFileApiPath(agentSlug, filePath)
  // An upload lives at a path stamped with the millisecond it arrived and is
  // never rewritten, so its size cannot go stale.
  const { data: sizeBytes } = useFileSize(fileApiPath, 0, { immutable: true })
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
        // `alt` is the whole accessible name here — a second copy in an sr-only
        // span had screen readers announce the filename twice for one picture.
        <img
          src={getAgentFileUrl(agentSlug, filePath, { inline: true })}
          alt={name}
          onError={() => setImageBroken(true)}
          // These are the uploaded originals at full resolution, drawn into a
          // 256px-capped box or a grid square. Lazily loaded so a thread of them
          // costs nothing until scrolled to, and decoded off the main thread so
          // a phone photo does not stall the message list when it is.
          loading="lazy"
          decoding="async"
          className={cn(
            'block',
            imageSize === 'grid' ? 'h-full w-full object-cover' : 'h-auto max-h-64 w-auto max-w-full',
          )}
        />
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
