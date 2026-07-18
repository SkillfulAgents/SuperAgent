import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AudioLines, MessageSquarePlus, Pause, Play } from 'lucide-react'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { CommentOverlay } from '../comments/comment-overlay'
import { formatMediaTime } from '../comments/format-media-time'
import { createFallbackWaveform, createWaveformPeaks } from './audio-waveform'

interface AudioRendererProps {
  url: string
  filePath: string
}

interface PendingComment {
  timestamp: number
  rect: DOMRect
}

type AudioComment = FileComment & { timestamp: number }

const WAVEFORM_BAR_COUNT = 112
const MAX_WAVEFORM_BYTES = 50 * 1024 * 1024

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function validDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

export function AudioRenderer({ url, filePath }: AudioRendererProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playedFillId = `audio-played-${useId().replace(/:/g, '')}`
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [pending, setPending] = useState<PendingComment | null>(null)
  const [waveform, setWaveform] = useState(() => createFallbackWaveform(WAVEFORM_BAR_COUNT))

  const { comments } = useFilePreview()
  const fileComments = comments.get(filePath) || []
  const audioComments = fileComments.filter((comment): comment is AudioComment => comment.timestamp != null)
  const maxSeek = validDuration(duration)
  const playedRatio = maxSeek > 0 ? clamp(currentTime / maxSeek, 0, 1) : 0
  const filename = getFilename(filePath)

  useEffect(() => {
    const controller = new AbortController()
    setWaveform(createFallbackWaveform(WAVEFORM_BAR_COUNT))

    async function decodeWaveform() {
      try {
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) return

        const contentLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(contentLength) && contentLength > MAX_WAVEFORM_BYTES) return

        const encodedAudio = await response.arrayBuffer()
        if (controller.signal.aborted || encodedAudio.byteLength > MAX_WAVEFORM_BYTES) return

        const decoder = new OfflineAudioContext(1, 1, 44_100)
        const audioBuffer = await decoder.decodeAudioData(encodedAudio)
        if (controller.signal.aborted) return

        const channels = Array.from(
          { length: audioBuffer.numberOfChannels },
          (_, channel) => audioBuffer.getChannelData(channel),
        )
        setWaveform(createWaveformPeaks(channels, WAVEFORM_BAR_COUNT))
      } catch (error) {
        if (!controller.signal.aborted) {
          // The audio element may still support playback even when Web Audio
          // cannot decode the source, so retain the fallback waveform.
          console.debug('Could not decode audio waveform', error)
        }
      }
    }

    void decodeWaveform()
    return () => controller.abort()
  }, [url])

  // `timeupdate` is intentionally throttled by browsers and makes a custom
  // playhead advance in noticeable jumps. Sample the media clock every frame
  // while playback is active, then fall back to media events while paused.
  useEffect(() => {
    if (!playing) return

    let animationFrame = 0
    const updatePlayhead = () => {
      const audio = audioRef.current
      if (!audio || audio.paused || audio.ended) return
      setCurrentTime(audio.currentTime)
      animationFrame = requestAnimationFrame(updatePlayhead)
    }

    animationFrame = requestAnimationFrame(updatePlayhead)
    return () => cancelAnimationFrame(animationFrame)
  }, [playing])

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current == null) return
    clearTimeout(hoverCloseTimerRef.current)
    hoverCloseTimerRef.current = null
  }, [])

  const scheduleHoverClose = useCallback(() => {
    clearHoverCloseTimer()
    // Leave enough time to cross the small visual gap above the waveform. The
    // tooltip cancels this timer as soon as the pointer reaches it.
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoverTime(null)
      hoverCloseTimerRef.current = null
    }, 250)
  }, [clearHoverCloseTimer])

  useEffect(() => clearHoverCloseTimer, [clearHoverCloseTimer])

  const timeAtClientX = useCallback((clientX: number): number => {
    const timeline = timelineRef.current
    if (!timeline || maxSeek === 0) return 0
    const rect = timeline.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return clamp((clientX - rect.left) / rect.width, 0, 1) * maxSeek
  }, [maxSeek])

  const seekTo = useCallback((time: number) => {
    const audio = audioRef.current
    const nextTime = maxSeek > 0 ? clamp(time, 0, maxSeek) : 0
    if (audio && maxSeek > 0) audio.currentTime = nextTime
    setCurrentTime(nextTime)
  }, [maxSeek])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => {})
    else audio.pause()
  }, [])

  const beginComment = useCallback((timestamp: number) => {
    const audio = audioRef.current
    const timeline = timelineRef.current
    if (!audio || !timeline) return

    audio.pause()
    const lockedTime = maxSeek > 0 ? clamp(timestamp, 0, maxSeek) : 0
    const timelineRect = timeline.getBoundingClientRect()
    const x = maxSeek > 0 ? (lockedTime / maxSeek) * timelineRect.width : timelineRect.width / 2
    setPending({
      timestamp: lockedTime,
      rect: new DOMRect(x, timelineRect.height, 0, 0),
    })
    clearHoverCloseTimer()
    setHoverTime(null)
  }, [clearHoverCloseTimer, maxSeek])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pending) return
    const target = event.target as HTMLElement
    if (target.closest('[data-audio-hover-tooltip]')) return
    clearHoverCloseTimer()
    setHoverTime(timeAtClientX(event.clientX))
  }, [clearHoverCloseTimer, pending, timeAtClientX])

  const hoverRatio = hoverTime != null && maxSeek > 0 ? clamp(hoverTime / maxSeek, 0, 1) : 0.5

  const commentMarkers = useMemo(() => audioComments.map(comment => ({
    ...comment,
    ratio: maxSeek > 0 ? clamp(comment.timestamp / maxSeek, 0, 1) : 0,
  })), [audioComments, maxSeek])

  return (
    <div className="flex min-h-full items-start justify-center p-5" data-testid="audio-renderer">
      <div className="w-full max-w-[720px] rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm sm:p-5">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <AudioLines className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{filename}</div>
            <div className="text-xs text-muted-foreground">Audio preview</div>
          </div>
        </div>

        {/* Agent-delivered audio has no caption track to offer. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          data-testid="audio-element"
          onLoadedMetadata={event => setDuration(validDuration(event.currentTarget.duration))}
          onDurationChange={event => setDuration(validDuration(event.currentTarget.duration))}
          onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        <div
          className="group relative h-28 rounded-lg border border-border/60 bg-muted/30 focus-within:ring-1 focus-within:ring-primary"
          data-testid="audio-waveform"
          onPointerMove={handlePointerMove}
          onPointerLeave={scheduleHoverClose}
        >
          {/* Every time-based element lives in this shared inset coordinate
              system so a ratio maps to the same physical x-position. */}
          <div
            ref={timelineRef}
            className="absolute inset-x-2 inset-y-3"
            data-testid="audio-timeline"
          >
            <svg
              viewBox={`0 0 ${WAVEFORM_BAR_COUNT} 100`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
              aria-hidden="true"
            >
              <defs>
                <linearGradient
                  id={playedFillId}
                  gradientUnits="userSpaceOnUse"
                  x1={0}
                  x2={WAVEFORM_BAR_COUNT}
                >
                  <stop
                    offset={`${playedRatio * 100}%`}
                    stopColor="hsl(var(--primary))"
                    data-testid="audio-waveform-progress"
                  />
                  <stop
                    offset={`${playedRatio * 100}%`}
                    stopColor="hsl(var(--muted-foreground))"
                    stopOpacity={0.35}
                  />
                </linearGradient>
              </defs>
              <g fill={`url(#${playedFillId})`}>
                {waveform.map((peak, index) => {
                  const height = Math.max(4, peak * 82)
                  return (
                    <rect
                      key={index}
                      x={index + 0.16}
                      y={(100 - height) / 2}
                      width={0.68}
                      height={height}
                      rx={0.34}
                    />
                  )
                })}
              </g>
            </svg>

            {maxSeek > 0 && (
              <div
                className="pointer-events-none absolute -inset-y-1 z-10 w-px bg-primary/80"
                style={{ left: `${playedRatio * 100}%` }}
                aria-hidden="true"
                data-testid="audio-playhead"
              />
            )}

            {commentMarkers.map((comment, index) => (
              <button
                key={comment.id}
                type="button"
                onClick={() => seekTo(comment.timestamp)}
                className="absolute -top-2 z-30 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground shadow ring-2 ring-background transition-transform hover:scale-110"
                style={{ left: `${comment.ratio * 100}%` }}
                title={`Comment at ${formatMediaTime(comment.timestamp)}`}
                aria-label={`Seek to comment ${index + 1} at ${formatMediaTime(comment.timestamp)}`}
              >
                {index + 1}
              </button>
            ))}

            <input
              type="range"
              min={0}
              max={maxSeek}
              step={0.01}
              value={Math.min(currentTime, maxSeek)}
              onChange={event => seekTo(Number(event.target.value))}
              aria-label="Seek audio"
              aria-valuetext={formatMediaTime(currentTime)}
              className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
              data-testid="audio-seek"
            />

            {hoverTime != null && !pending && (
              <div
                className="pointer-events-none absolute -top-2 z-40 -translate-x-1/2 -translate-y-full pb-1"
                style={{ left: `${hoverRatio * 100}%` }}
                data-audio-hover-tooltip
                onPointerEnter={clearHoverCloseTimer}
                onPointerLeave={scheduleHoverClose}
              >
                <button
                  type="button"
                  className="pointer-events-auto flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-md hover:bg-primary/90"
                  onClick={event => {
                    event.stopPropagation()
                    beginComment(hoverTime)
                  }}
                  data-testid="audio-hover-add-comment"
                >
                  <MessageSquarePlus className="h-3 w-3" />
                  Add Comment
                </button>
                <div className="text-center text-[9px] tabular-nums text-muted-foreground">
                  {formatMediaTime(hoverTime)}
                </div>
              </div>
            )}

            {pending && (
              <CommentOverlay
                selection={{ text: '', rect: pending.rect, timestamp: pending.timestamp }}
                filePath={filePath}
                autoEdit
                onClose={() => setPending(null)}
              />
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
          </button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
          </span>
          <button
            type="button"
            onClick={() => beginComment(currentTime)}
            disabled={pending != null}
            className="ml-auto flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-50"
            data-testid="audio-add-comment"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Add Comment
          </button>
        </div>
      </div>
    </div>
  )
}
