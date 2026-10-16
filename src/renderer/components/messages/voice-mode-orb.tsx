import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Mic, MicOff, Volume2, VolumeOff, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AwaitingDot } from '@renderer/components/agents/status-indicators'
import { useSession } from '@renderer/hooks/use-sessions'
import { usePendingRequests } from '@shared/lib/tools/requests/use-pending-requests'
import { describeVoiceInputRequest } from '@shared/lib/tools/registry'
import { cn } from '@shared/lib/utils'
import { VoiceOrb } from './voice-orb'
import { orbStateFor } from './voice-mode-composer'
import { VoiceToggleButton } from './voice-mode-controls'
import { useVoiceModeHost, type VoiceSession } from './voice-mode-host'

const ORB_SIZE = 48
const EDGE = 16
const DRAG_THRESHOLD = 4
const POSITION_KEY = 'voice-mode-orb-position'

interface OrbPosition {
  side: 'left' | 'right'
  bottom: number
}

function clampBottom(bottom: number): number {
  return Math.min(Math.max(bottom, EDGE), window.innerHeight - ORB_SIZE - EDGE)
}

function loadPosition(): OrbPosition {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as OrbPosition | null
    if (saved && (saved.side === 'left' || saved.side === 'right') && typeof saved.bottom === 'number') {
      return { side: saved.side, bottom: clampBottom(saved.bottom) }
    }
  } catch {
    // A bad saved value falls back to the default.
  }
  // Above the composer, clear of its model picker.
  return { side: 'right', bottom: 120 }
}

/** The voice conversation, shrunk to its orb, wherever its session is not on screen. */
export function VoiceModeOrb() {
  const { session } = useVoiceModeHost()
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  if (!session || sessionId === session.sessionId) return null
  return <FloatingOrb session={session} />
}

function FloatingOrb({ session }: { session: VoiceSession }) {
  const { voice, exit, registerView } = useVoiceModeHost()
  const navigate = useNavigate()
  const { data: sessionInfo } = useSession(session.sessionId, session.agentSlug)
  const frameRef = useRef<HTMLDivElement>(null)

  const { items: requests } = usePendingRequests({ sessionId: session.sessionId, agentSlug: session.agentSlug })
  const inputRequests = useMemo(() => requests.map(describeVoiceInputRequest), [requests])
  const needsInput = requests.length > 0
  useEffect(
    () => registerView({ kind: 'orb', suspended: needsInput, inputRequests, frameRef }),
    [registerView, needsInput, inputRequests],
  )

  const [position, setPosition] = useState(loadPosition)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const dragStart = useRef<{ pointerX: number; pointerY: number; left: number; top: number; moved: boolean } | null>(null)

  const open = () => void navigate({
    to: '/agents/$slug/sessions/$sessionId',
    params: { slug: session.agentSlug, sessionId: session.sessionId },
  })

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    dragStart.current = { pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current
    if (!start) return
    const dx = event.clientX - start.pointerX
    const dy = event.clientY - start.pointerY
    if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    start.moved = true
    setDrag({ x: start.left + dx, y: start.top + dy })
  }
  const onPointerUp = () => {
    const start = dragStart.current
    dragStart.current = null
    if (!start?.moved || !drag) {
      open()
      return
    }
    const next: OrbPosition = {
      side: drag.x + ORB_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right',
      bottom: clampBottom(window.innerHeight - drag.y - ORB_SIZE),
    }
    setDrag(null)
    setPosition(next)
    localStorage.setItem(POSITION_KEY, JSON.stringify(next))
  }

  const name = sessionInfo?.name ?? 'Voice mode'
  const notice = needsInput ? 'Needs your input' : voice.error
  const style = drag
    ? { left: drag.x, top: drag.y }
    : { [position.side]: EDGE, bottom: position.bottom }

  return (
    <div
      ref={frameRef}
      className={cn('group fixed z-50 flex items-center gap-2', position.side === 'right' && 'flex-row-reverse')}
      style={style}
      data-testid="voice-mode-orb"
      data-phase={voice.phase}
    >
      <div className="relative shrink-0">
        <button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-label={`Open ${name}`}
          title={name}
          className={cn(
            'flex items-center justify-center overflow-hidden rounded-full border bg-background shadow-md touch-none',
            drag ? 'cursor-grabbing' : 'cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          style={{ width: ORB_SIZE, height: ORB_SIZE }}
          data-testid="voice-mode-orb-open"
        >
          <VoiceOrb
            state={orbStateFor(voice.phase, voice.ready, voice.userSpeaking)}
            monochrome={!voice.ready || voice.micMuted}
            size={112}
            getAnalyser={voice.phase === 'speaking' ? voice.getOutputAnalyser : voice.getAnalyser}
            className="shrink-0"
          />
        </button>
        {needsInput ? (
          <span className="absolute -right-0.5 -top-0.5 rounded-full bg-background p-0.5"><AwaitingDot /></span>
        ) : voice.micMuted ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border bg-background" aria-label="microphone muted">
            <MicOff className="h-2.5 w-2.5 text-muted-foreground" />
          </span>
        ) : null}
        {notice && !drag && (
          <div
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border bg-background px-3 py-1 text-xs shadow-sm transition-opacity group-hover:opacity-0',
              voice.error && !needsInput ? 'text-destructive' : 'text-foreground',
              position.side === 'right' ? 'right-full mr-2' : 'left-full ml-2',
            )}
            aria-live="polite"
            data-testid="voice-mode-orb-notice"
          >
            {notice}
          </div>
        )}
      </div>
      {!drag && (
        <div className="pointer-events-none flex items-center gap-1 rounded-full border bg-background p-1 shadow-sm opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <span className="max-w-40 truncate px-2 text-xs text-muted-foreground">{name}</span>
          <VoiceToggleButton
            label={voice.outputMuted ? 'Unmute agent speech' : 'Mute agent speech'}
            pressed={voice.outputMuted}
            onClick={() => voice.setOutputMuted(!voice.outputMuted)}
            testId="voice-mode-orb-mute-output"
            className="h-7 w-7 rounded-full"
          >
            {voice.outputMuted ? <VolumeOff className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </VoiceToggleButton>
          <VoiceToggleButton
            label={voice.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            pressed={voice.micMuted}
            onClick={() => voice.setMicMuted(!voice.micMuted)}
            testId="voice-mode-orb-mute"
            className="h-7 w-7 rounded-full"
          >
            {voice.micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </VoiceToggleButton>
          <Button
            type="button"
            size="icon"
            className="h-7 w-7 rounded-full"
            onClick={exit}
            aria-label="Exit voice mode"
            title="Exit voice mode"
            data-testid="voice-mode-orb-exit"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
