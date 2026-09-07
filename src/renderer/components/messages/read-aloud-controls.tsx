import { Loader2, Pause, Play, Square, Volume2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useIsTtsConfigured } from '@renderer/hooks/use-voice-input'
import { readAloud, useReadAloud, type ReadAloudStatus } from '@renderer/hooks/use-read-aloud'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { DEFAULT_TTS_SPEED, TTS_SPEEDS, ttsSpeedSchema } from '@shared/lib/stt/tts-preferences'
import { cn } from '@shared/lib/utils/cn'

interface ReadAloudControlsProps {
  messageId: string
  /** The message's Markdown; what gets spoken. */
  markdown: string
  className?: string
}

const ICON_BUTTON = cn(
  'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors',
  'hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]',
)
const ICON = 'h-3.5 w-3.5'

function IconButton({ label, onClick, testId, status, shown, children }: {
  label: string
  onClick: () => void
  testId: string
  status: ReadAloudStatus
  shown: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
          data-status={status}
          className={cn(ICON_BUTTON, !shown && 'hidden')}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Speaking rate, written to the user's own settings. A synthesizer
 * connection is fixed to one speed, so a change mid-reply restarts playback
 * from the current word with the new one.
 */
function SpeedSelect({ shown }: { shown: boolean }) {
  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const stored = ttsSpeedSchema.safeParse(userSettings?.voice?.ttsSpeed)
  const speed = stored.success ? stored.data : DEFAULT_TTS_SPEED
  const preset = TTS_SPEEDS.find((s) => s.value === speed)

  return (
    <Select
      value={String(speed)}
      onValueChange={(v) => {
        const ttsSpeed = Number(v)
        if (ttsSpeed === speed) return
        updateUserSettings.mutate({ voice: { ttsSpeed } }, { onSuccess: () => readAloud.restart() })
      }}
    >
      <SelectTrigger
        aria-label="Reading speed"
        data-testid="read-aloud-speed"
        className={cn(
          'h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none',
          'hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1] [&>svg]:h-3 [&>svg]:w-3',
          !shown && 'hidden',
        )}
      >
        <SelectValue>{preset?.value === 1 ? '1×' : (preset?.label ?? `${speed}×`)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {TTS_SPEEDS.map((s) => (
          <SelectItem key={s.value} value={String(s.value)}>{s.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Playback controls under an assistant reply. Idle: one speaker button.
 * While reading: pause/resume, stop, and the speed picker. Hidden entirely
 * when the voice provider can't synthesize speech.
 *
 * Every control stays mounted and only toggles display. Swapping the row's
 * children on play makes WebKit re-clamp the scroll container when the reply
 * sits at the live edge (the viewport drops by the row's height, the same
 * failure the prose spans had); display changes never do.
 */
export function ReadAloudControls({ messageId, markdown, className }: ReadAloudControlsProps) {
  const configured = useIsTtsConfigured()
  const { status, toggle, pause, resume, error } = useReadAloud(messageId, markdown)
  if (!configured) return null
  const active = status !== 'idle'

  return (
    <TooltipProvider>
      <div className={cn('flex items-center gap-0.5', className)} data-testid="read-aloud-controls" data-status={status}>
        <IconButton label="Read aloud" onClick={toggle} testId="read-aloud-button" status={status} shown={!active}>
          <Volume2 className={ICON} />
        </IconButton>
        <span
          role="alert"
          data-testid="read-aloud-error"
          className={cn('text-xs text-destructive', !(error && !active) && 'hidden')}
        >
          {error}
        </span>
        <span className={cn(ICON_BUTTON, status !== 'connecting' && 'hidden')} aria-label="Connecting" data-testid="read-aloud-connecting">
          <Loader2 className={cn(ICON, 'animate-spin')} />
        </span>
        <IconButton label="Pause" onClick={pause} testId="read-aloud-pause" status={status} shown={status === 'speaking'}>
          <Pause className={cn(ICON, 'fill-current')} />
        </IconButton>
        <IconButton label="Resume" onClick={resume} testId="read-aloud-resume" status={status} shown={status === 'paused'}>
          <Play className={cn(ICON, 'fill-current')} />
        </IconButton>
        <IconButton label="Stop reading" onClick={toggle} testId="read-aloud-stop" status={status} shown={active}>
          <Square className={cn(ICON, 'fill-current')} />
        </IconButton>
        <SpeedSelect shown={active} />
      </div>
    </TooltipProvider>
  )
}
