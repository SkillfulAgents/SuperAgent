import { cn } from '@shared/lib/utils/cn'
import { SentAttachmentChip, imageSizeForCount } from './sent-attachment-chip'

export interface AttachedImage {
  /** Unique among its siblings: the same picture can appear twice. */
  key: string
  filePath: string
  description?: string
  sizeBytes?: number
}

interface AttachedImagesProps {
  images: AttachedImage[]
  agentSlug: string
  /** Which side of the thread the pictures hang from: `end` for the user, `start` for the agent. */
  align: 'start' | 'end'
  'data-testid'?: string
}

/**
 * The pictures a message carries, laid out the same way whoever sent them:
 * stacked at native aspect for up to three, a 3-column grid of squares beyond
 * that. A user's uploads and an agent's delivered images differ only in which
 * side of the thread they sit on.
 */
export function AttachedImages({ images, agentSlug, align, 'data-testid': testId }: AttachedImagesProps) {
  const imageSize = imageSizeForCount(images.length)
  return (
    <div
      className={cn(
        imageSize === 'grid'
          // more than three: a 3-column grid of squares, bounded
          ? cn('grid w-full max-w-md grid-cols-3 gap-2', align === 'end' && 'ml-auto')
          // up to three: stacked, each at native aspect
          : cn('flex flex-col gap-2', align === 'end' ? 'items-end' : 'items-start'),
      )}
      data-testid={testId}
      data-image-layout={imageSize}
    >
      {images.map((image) => (
        <SentAttachmentChip
          key={image.key}
          filePath={image.filePath}
          agentSlug={agentSlug}
          imageSize={imageSize}
          description={image.description}
          sizeBytes={image.sizeBytes}
        />
      ))}
    </div>
  )
}
