import { useRef, type RefObject } from 'react'
import { CommentPin } from '../comment-pin'
import { formatCommentTime } from '../format-media-time'
import { describePoint, type Point } from './point'
import { percentIn, type AnchorKindSpec, type MarkerProps, type PointerAt } from './types'

export interface TimeAnchor {
  kind: 'time'
  /** Playback position in seconds. */
  seconds: number
  /** Where on the frame, for video. */
  point?: Point
}
export interface TimeSurface {
  media: RefObject<HTMLMediaElement | null>
  /** The timeline a position maps to a time on, and its ticks sit on. */
  track: RefObject<HTMLElement | null>
  /** Video's frame: a time comment also holds a point on it. */
  frame?: RefObject<HTMLElement | null>
}

/** How close (in seconds) the playhead must be to a comment to show its pin on the frame. */
const PIN_VISIBLE_WINDOW = 0.4
const CENTER = { x: 50, y: 50 }

function durationOf(media: HTMLMediaElement): number {
  return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0
}

function framePoint({ frame }: TimeSurface, at: PointerAt): Point | null {
  const el = frame?.current
  if (!el?.contains(at.target)) return null
  return percentIn(el.getBoundingClientRect(), at.clientX, at.clientY)
}

function TimeMarker({ slice, anchor, site, numbers, isOpen, refine }: MarkerProps<TimeAnchor, TimeSurface>) {
  const dragging = useRef(false)
  if (site.host === slice.frame?.current) {
    if (!isOpen) return <CommentPin x={site.x} y={site.y} number={numbers[0]} />
    const at = (e: React.PointerEvent): PointerAt => ({ on: 'click', target: site.host, clientX: e.clientX, clientY: e.clientY })
    return (
      <div
        data-comment-marker
        role="presentation"
        onPointerDown={e => { e.preventDefault(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (dragging.current) refine(at(e)) }}
        onPointerUp={e => { dragging.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId) }}
        className="absolute w-9 h-9 -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-primary bg-primary/20 shadow-md cursor-move touch-none flex items-center justify-center"
        style={{ left: `${site.x}%`, top: `${site.y}%` }}
        title="Drag to position the comment"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-primary" />
      </div>
    )
  }
  if (!slice.media.current || !durationOf(slice.media.current)) return null
  const time = formatCommentTime(anchor.seconds)
  return (
    <button
      data-comment-marker
      type="button"
      onClick={() => { if (slice.media.current) slice.media.current.currentTime = anchor.seconds }}
      className="absolute top-0 z-30 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground shadow ring-2 ring-background transition-transform hover:scale-110"
      style={{ left: `${site.x}%` }}
      title={`Comment at ${time}`}
      aria-label={`Seek to comment ${numbers[0]} at ${time}`}
    >
      {numbers[0]}
    </button>
  )
}

export const timeKind: AnchorKindSpec<TimeAnchor, TimeSurface> = {
  fromClick: (slice, at, open) => {
    const point = framePoint(slice, at)
    const media = slice.media.current
    if (!point || !media) return null
    // Refining keeps the locked time and moves only the point.
    return open ? { ...open, point } : { kind: 'time', seconds: media.currentTime, point }
  },
  fromMouse: (slice, at) => {
    const media = slice.media.current
    if (!media) return null
    const point = framePoint(slice, at)
    if (point) return { kind: 'time', seconds: media.currentTime, point }
    const track = slice.track.current
    const duration = durationOf(media)
    if (!track?.contains(at.target) || !duration) return null
    const { x } = percentIn(track.getBoundingClientRect(), at.clientX, at.clientY)
    // No point: the frame on screen is not the frame at that time.
    return { kind: 'time', seconds: (x / 100) * duration }
  },
  fromElsewhere: ({ media, frame }) =>
    media.current ? { kind: 'time', seconds: media.current.currentTime, point: frame ? CENTER : undefined } : null,
  prepare: ({ media }) => media.current?.pause(),
  describe: ({ seconds, point }) => `At ${formatCommentTime(seconds)}${point ? ` at ${describePoint(point)}` : ''}`,
  locate: ({ media, track, frame }, { seconds, point }, isOpen) => {
    if (!media.current) return []
    const sites = []
    if (frame?.current && point && (isOpen || Math.abs(seconds - media.current.currentTime) <= PIN_VISIBLE_WINDOW)) {
      sites.push({ host: frame.current, ...point })
    }
    const duration = durationOf(media.current)
    // Before the length is known, an open comment still sits under the timeline's middle; its tick waits.
    if (track.current && (duration || isOpen)) {
      sites.push({ host: track.current, x: duration ? Math.min(100, (seconds / duration) * 100) : 50, y: 100 })
    }
    return sites
  },
  Marker: TimeMarker,
}
