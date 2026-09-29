import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { isAnyVoiceModeActive } from '@renderer/lib/voice-mode-handoff'

/** YouTube's playback speeds. */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export type MediaKeyAction =
  | { type: 'toggle' }
  | { type: 'seek'; seconds: number }
  | { type: 'step'; direction: 1 | -1 }
  | { type: 'rate'; direction: 1 | -1 }
  | { type: 'comment' }

/**
 * The player action a key press asks for (YouTube's keys), or null when the
 * key belongs to something else: a text field, an open menu or dialog, an app
 * shortcut held with Cmd/Ctrl/Alt, or a control that already handled it.
 */
export function mediaKeyAction(event: KeyboardEvent): MediaKeyAction | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null
  const target = event.target
  if (target instanceof Element && target.closest('input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')) return null
  // A focused control keeps Space, as it does in the browser; K still plays and pauses.
  if (event.key === ' ' && target instanceof Element && target.closest('button, a[href], [role="button"]')) return null
  switch (event.key) {
    case ' ': case 'k': case 'K': return { type: 'toggle' }
    case 'j': case 'J': return { type: 'seek', seconds: -10 }
    case 'l': case 'L': return { type: 'seek', seconds: 10 }
    case 'ArrowLeft': return event.shiftKey ? { type: 'seek', seconds: -5 } : { type: 'step', direction: -1 }
    case 'ArrowRight': return event.shiftKey ? { type: 'seek', seconds: 5 } : { type: 'step', direction: 1 }
    // Some layouts report Shift+. as '.' rather than '>'.
    case ',': return event.shiftKey ? { type: 'rate', direction: -1 } : { type: 'step', direction: -1 }
    case '.': return event.shiftKey ? { type: 'rate', direction: 1 } : { type: 'step', direction: 1 }
    case '<': return { type: 'rate', direction: -1 }
    case '>': return { type: 'rate', direction: 1 }
    case 'c': case 'C': return { type: 'comment' }
    default: return null
  }
}

type FrameSample = Pick<VideoFrameCallbackMetadata, 'mediaTime' | 'presentedFrames'>

/**
 * Seconds per frame between two frame callbacks, or null when the pair cannot
 * tell (no time passed, a backward seek, no frame shown). Dividing by the
 * frames shown keeps a skipped callback from reading as one long frame.
 */
export function frameSeconds(prev: FrameSample, next: FrameSample): number | null {
  const frames = next.presentedFrames - prev.presentedFrames
  const elapsed = next.mediaTime - prev.mediaTime
  return frames > 0 && elapsed > 0 ? elapsed / frames : null
}

interface MediaKeysOptions {
  /** Seconds one frame lasts. Video passes it, so a step pauses and moves one frame; audio steps 5 s. */
  frameStep?: () => number
  /** Opens a comment at the playhead; absent while comments are off or one is already open. */
  onComment?: () => void
}

/**
 * Keyboard playback for the drawer's media player, active while it is mounted,
 * plus the play toggle and playback speed it controls. The drawer remounts the
 * player per file, so every file starts at 1×.
 */
export function useMediaKeys(mediaRef: RefObject<HTMLMediaElement | null>, options: MediaKeysOptions) {
  const [rate, setRate] = useState(1)
  const latest = useRef(options)
  useEffect(() => { latest.current = options })

  const togglePlay = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) void media.play().catch(() => {})
    else media.pause()
  }, [mediaRef])

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = rate
  }, [mediaRef, rate])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const media = mediaRef.current
      const action = media && mediaKeyAction(event)
      const { frameStep, onComment } = latest.current
      if (!media || !action || (action.type === 'comment' && !onComment)) return
      // While voice mode is on, Space belongs to the player only when focus is
      // inside it; elsewhere it interrupts the agent. K still plays and pauses.
      const inPlayer = event.target instanceof Node && media.closest('[data-media-player]')?.contains(event.target)
      if (event.key === ' ' && !inPlayer && isAnyVoiceModeActive()) return
      event.preventDefault()
      // Holding Space or C toggles or opens once.
      if (event.repeat && (action.type === 'toggle' || action.type === 'comment')) return
      switch (action.type) {
        case 'toggle':
          togglePlay()
          break
        case 'seek':
          // The browser clamps to the media's range.
          media.currentTime += action.seconds
          break
        case 'step':
          if (frameStep) media.pause()
          media.currentTime += action.direction * (frameStep ? frameStep() : 5)
          break
        case 'rate': {
          const index = PLAYBACK_RATES.indexOf(media.playbackRate) + action.direction
          setRate(PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, index))])
          break
        }
        case 'comment':
          onComment?.()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mediaRef, togglePlay])

  return { rate, setRate, togglePlay }
}
