import { useState, useRef, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useCommentBox } from '../comments/use-comment-box'

interface ImageRendererProps {
  url: string
  filePath: string
  agentSlug: string
}

export function ImageRenderer({ url, filePath, agentSlug }: ImageRendererProps) {
  const [loaded, setLoaded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLDivElement>(null)
  const surface = useMemo(() => ({ point: imageRef }), [])
  const { box, enabled } = useCommentBox(containerRef, surface, filePath, agentSlug)

  return (
    <div ref={containerRef} className="relative flex items-center justify-center p-4 min-h-[200px]">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <div ref={imageRef} className="relative inline-block">
        <img
          src={url}
          alt={filePath.split('/').pop() || 'Preview'}
          className={`max-w-full max-h-[60vh] object-contain rounded ${enabled ? 'cursor-crosshair' : ''}`}
          onLoad={() => setLoaded(true)}
        />
      </div>
      {box}
    </div>
  )
}
