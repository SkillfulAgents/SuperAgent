import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Expand, Play, Pause, MessageSquarePlus } from 'lucide-react'
import { useCommentBox } from '../comments/use-comment-box'
import { frameSeconds, useMediaKeys } from './use-media-keys'
import { PlaybackSpeedSelect } from './playback-speed'
import { VolumeControl } from './volume-control'
import { formatMediaTime } from '../comments/format-media-time'

interface VideoRendererProps {
  url: string
  filePath: string
  agentSlug: string
}

export function VideoRenderer({ url, filePath, agentSlug }: VideoRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [fullscreenSupported, setFullscreenSupported] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    setFullscreenSupported(typeof video?.requestFullscreen === 'function')
    const updateNativeControls = () => {
      if (video) video.controls = document.fullscreenElement === video
    }
    document.addEventListener('fullscreenchange', updateNativeControls)
    return () => document.removeEventListener('fullscreenchange', updateNativeControls)
  }, [])

  const enterFullscreen = useCallback(() => {
    const video = videoRef.current
    if (!video || typeof video.requestFullscreen !== 'function') return
    video.controls = true
    void video.requestFullscreen().catch(() => {
      video.controls = false
    })
  }, [])

  const surface = useMemo(() => ({ time: { media: videoRef, track: trackRef, frame: frameRef } }), [])
  const { box, open, enabled, isOpen } = useCommentBox(containerRef, surface, filePath, agentSlug)

  const seekTo = useCallback((time: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = time
    setCurrentTime(time)
  }, [])

  // Browsers don't expose the frame rate: take the shortest frame length seen
  // while playing, and assume 30 fps until one is seen.
  const frameDurationRef = useRef(Infinity)
  useEffect(() => {
    const v = videoRef.current
    // Firefox before 132 lacks the callback; steps then stay at the 30 fps guess.
    if (!playing || !v || !('requestVideoFrameCallback' in v)) return
    let last: VideoFrameCallbackMetadata | null = null
    let id = 0
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      const seconds = last && frameSeconds(last, meta)
      if (seconds) frameDurationRef.current = Math.min(frameDurationRef.current, seconds)
      last = meta
      id = v.requestVideoFrameCallback(onFrame)
    }
    // A pair of samples must not span a seek.
    const forgetLast = () => { last = null }
    v.addEventListener('seeking', forgetLast)
    id = v.requestVideoFrameCallback(onFrame)
    return () => {
      v.cancelVideoFrameCallback(id)
      v.removeEventListener('seeking', forgetLast)
    }
  }, [playing])

  const { rate, setRate, togglePlay } = useMediaKeys(videoRef, {
    frameStep: () => (Number.isFinite(frameDurationRef.current) ? frameDurationRef.current : 1 / 30),
  })

  const maxSeek = duration > 0 ? duration : 0

  return (
    <div ref={containerRef} className="relative flex flex-col items-center gap-3 p-4" data-testid="video-renderer" data-media-player>
      <div ref={frameRef} className={`relative inline-block max-w-full ${enabled ? 'cursor-crosshair' : ''}`}>
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
      </div>

      {/* Controls */}
      <div className="w-full max-w-[640px] space-y-2">
        {/* Scrubber, with comment ticks above the track. */}
        <div ref={trackRef} className="relative space-y-1">
          <div className="h-2" />
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
        <div className="flex flex-wrap items-center gap-3" data-testid="video-controls">
          <button
            type="button"
            onClick={togglePlay}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
          </button>
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {formatMediaTime(currentTime)} / {formatMediaTime(duration)}
          </span>
          <PlaybackSpeedSelect rate={rate} onChange={setRate} />
          <VolumeControl mediaRef={videoRef} />
          {(fullscreenSupported || enabled) && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {fullscreenSupported && (
                <button
                  type="button"
                  onClick={enterFullscreen}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-muted"
                  title="Full screen"
                  aria-label="Full screen"
                >
                  <Expand className="h-4 w-4" />
                </button>
              )}
              {enabled && (
                <button
                  type="button"
                  onClick={() => open()}
                  disabled={isOpen}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 text-xs rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-default"
                  data-testid="video-add-comment"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  Add Comment
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {box}
    </div>
  )
}
