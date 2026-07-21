import { useState, useRef, useCallback } from 'react'
import { Play, Pause, MessageSquarePlus } from 'lucide-react'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { CommentPin } from '../comments/comment-pin'
import { CommentOverlay } from '../comments/comment-overlay'
import { formatMediaTime } from '../comments/format-media-time'

interface VideoRendererProps {
  url: string
  filePath: string
  commentsEnabled?: boolean
}

/** An in-progress comment: a locked frame time plus a draggable in-frame point. */
interface PendingComment {
  timestamp: number
  /** Horizontal position as a 0–100 percentage of the frame width. */
  x: number
  /** Vertical position as a 0–100 percentage of the frame height. */
  y: number
  /** Where to anchor the comment editor, in frame-local pixels. */
  rect: DOMRect
}

/** A video comment always carries a timestamp; x/y are present when placed in-frame. */
type VideoComment = FileComment & { timestamp: number }

/** How close (in seconds) the playhead must be to a comment to show its pin. */
const PIN_VISIBLE_WINDOW = 0.4

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function VideoRenderer({ url, filePath, commentsEnabled = true }: VideoRendererProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [pending, setPending] = useState<PendingComment | null>(null)

  const { comments } = useFilePreview()
  const fileComments = comments.get(filePath) || []
  const videoComments = fileComments.filter((c): c is VideoComment => c.timestamp != null)

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  const seekTo = useCallback((time: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = time
    setCurrentTime(time)
  }, [])

  // Start a comment at the current frame: pause, lock the timestamp, drop the
  // draggable point. `xy` is the click position (frame %), or null to centre it.
  const beginComment = useCallback((xy: { x: number; y: number } | null) => {
    const v = videoRef.current
    const frame = frameRef.current
    if (!v || !frame) return
    v.pause()
    const frameRect = frame.getBoundingClientRect()
    const x = xy ? clampPct(xy.x) : 50
    const y = xy ? clampPct(xy.y) : 50
    setPending({
      timestamp: v.currentTime,
      x,
      y,
      rect: new DOMRect((x / 100) * frameRect.width, (y / 100) * frameRect.height, 0, 0),
    })
  }, [])

  const handleFrameClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    // Clicks inside the editor or on the draggable point are handled there.
    if (target.closest('[data-comment-overlay]') || target.closest('[data-comment-box]')) return
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const x = clampPct(((e.clientX - rect.left) / rect.width) * 100)
    const y = clampPct(((e.clientY - rect.top) / rect.height) * 100)
    // While a comment is being placed, a frame click just repositions the point;
    // otherwise it opens a new comment at the click.
    if (pending) setPending(p => (p ? { ...p, x, y } : p))
    else beginComment({ x, y })
  }, [pending, beginComment])

  const handleBoxPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handleBoxPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const x = clampPct(((e.clientX - rect.left) / rect.width) * 100)
    const y = clampPct(((e.clientY - rect.top) / rect.height) * 100)
    setPending(p => (p ? { ...p, x, y } : p))
  }, [])

  const handleBoxPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  const maxSeek = duration > 0 ? duration : 0

  return (
    <div className="flex flex-col items-center gap-3 p-4" data-testid="video-renderer">
      {/* Video frame — clicking anywhere starts a comment at that point. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        ref={frameRef}
        className={`relative inline-block max-w-full ${commentsEnabled ? 'cursor-crosshair' : ''}`}
        onClick={commentsEnabled ? handleFrameClick : undefined}
      >
        {/* Agent-delivered videos have no caption track to offer. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={url}
          playsInline
          preload="metadata"
          className="max-w-full max-h-[60vh] rounded bg-black block"
          data-testid="video-element"
          onLoadedMetadata={e => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        {/* Pins for comments anchored near the current frame. */}
        {commentsEnabled && videoComments.map((comment, i) =>
          comment.x != null && comment.y != null && Math.abs(comment.timestamp - currentTime) <= PIN_VISIBLE_WINDOW ? (
            <CommentPin key={comment.id} x={comment.x} y={comment.y} number={i + 1} />
          ) : null,
        )}

        {/* Draggable point for the comment being placed. */}
        {commentsEnabled && pending && (
          <div
            data-comment-box
            role="presentation"
            onPointerDown={handleBoxPointerDown}
            onPointerMove={handleBoxPointerMove}
            onPointerUp={handleBoxPointerUp}
            className="absolute w-9 h-9 -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-primary bg-primary/20 shadow-md cursor-move touch-none flex items-center justify-center"
            style={{ left: `${pending.x}%`, top: `${pending.y}%` }}
            title="Drag to position the comment"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          </div>
        )}

        {commentsEnabled && pending && (
          <CommentOverlay
            selection={{
              text: '',
              rect: pending.rect,
              x: pending.x,
              y: pending.y,
              timestamp: pending.timestamp,
            }}
            filePath={filePath}
            autoEdit
            onClose={() => setPending(null)}
          />
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-[640px] space-y-2">
        {/* Scrubber with comment markers above the track. */}
        <div className="space-y-1">
          <div className="relative h-2">
            {maxSeek > 0 &&
              commentsEnabled && videoComments.map(comment => (
                <button
                  key={comment.id}
                  type="button"
                  onClick={() => seekTo(comment.timestamp)}
                  style={{ left: `${(comment.timestamp / maxSeek) * 100}%` }}
                  className="absolute top-0 h-2 w-1 -translate-x-1/2 rounded-sm bg-primary hover:scale-y-150 transition-transform"
                  title={`Comment at ${formatMediaTime(comment.timestamp)}`}
                />
              ))}
          </div>
          <input
            type="range"
            min={0}
            max={maxSeek}
            step={0.01}
            value={Math.min(currentTime, maxSeek)}
            onChange={e => seekTo(Number(e.target.value))}
            aria-label="Seek"
            className="w-full accent-primary cursor-pointer"
          />
        </div>

        {/* Transport + add-comment affordance. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
          </button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
          </span>
          {commentsEnabled && (
            <button
              type="button"
              onClick={() => beginComment(null)}
              disabled={pending != null}
              className="ml-auto flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-default"
              data-testid="video-add-comment"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Add Comment
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
