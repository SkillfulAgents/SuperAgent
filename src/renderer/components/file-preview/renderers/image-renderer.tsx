import { useState, useRef, useCallback, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { CommentPin } from '../comments/comment-pin'
import { CommentOverlay } from '../comments/comment-overlay'

interface ImageRendererProps {
  url: string
  filePath: string
}

interface ClickPoint {
  x: number
  y: number
  rect: DOMRect
}

export function ImageRenderer({ url, filePath }: ImageRendererProps) {
  const [loaded, setLoaded] = useState(false)
  const [clickPoint, setClickPoint] = useState<ClickPoint | null>(null)
  const imgContainerRef = useRef<HTMLDivElement>(null)
  const { comments } = useFilePreview()
  const fileComments = comments.get(filePath) || []
  const imageComments = fileComments.filter((c): c is FileComment & { x: number; y: number } => c.x != null && c.y != null)

  useEffect(() => {
    if (!clickPoint) return
    const handleMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-comment-overlay]')) return
      setClickPoint(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [clickPoint])

  const handleImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const rect = img.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    const containerRect = imgContainerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    setClickPoint({
      x,
      y,
      rect: new DOMRect(
        e.clientX - containerRect.left,
        e.clientY - containerRect.top,
        0,
        0
      ),
    })
  }, [])

  return (
    <div ref={imgContainerRef} className="relative flex items-center justify-center p-4 min-h-[200px]">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <div className="relative inline-block">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
        <img
          src={url}
          alt={filePath.split('/').pop() || 'Preview'}
          className="max-w-full max-h-[60vh] object-contain cursor-crosshair rounded"
          onLoad={() => setLoaded(true)}
          onClick={handleImageClick}
        />
        {imageComments.map((comment, i) => (
          <CommentPin
            key={comment.id}
            x={comment.x}
            y={comment.y}
            number={i + 1}
          />
        ))}
      </div>
      {clickPoint && (
        <CommentOverlay
          selection={{
            text: '',
            rect: clickPoint.rect,
            x: clickPoint.x,
            y: clickPoint.y,
          }}
          filePath={filePath}
          onClose={() => setClickPoint(null)}
        />
      )}
    </div>
  )
}
