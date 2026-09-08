import { useEffect, useRef, type ReactNode } from 'react'
import { Mic, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { cn } from '@shared/lib/utils'
import type { VoiceModePhase } from '@renderer/hooks/use-voice-mode'

interface VoiceModeComposerProps {
  phase: VoiceModePhase
  /** What the person has said so far; shown while they are talking. */
  utterance: string
  error: string | null
  onClearError: () => void
  onPressMic: () => void
  /** The mic's analyser, for the level-driven pulse. Null until the mic is open. */
  getAnalyser: () => AnalyserNode | null
  onExit: () => void
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  onRetryAttachment: (id: string) => void
  /** The "+" attachment picker, owned by the composer. */
  attachmentPicker: ReactNode
  /** The model selector, owned by the composer. */
  composerOptions: ReactNode
  /** Voice mode's own settings (reading speed, hold sound), shown beside the model selector. */
  voiceControls?: ReactNode
  footer?: ReactNode
}

const MIC_LABEL: Record<VoiceModePhase, string> = {
  listening: 'Send what you said',
  thinking: 'Interrupt and talk',
  speaking: 'Interrupt and talk',
}

/**
 * The composer while voice mode is on: a large mic in place of the text box,
 * pulsing with the person's voice while it is their turn and glowing while
 * the reply is read. The transcript of what they are saying sits above it;
 * the attachment picker, model selector, and exit sit around it.
 */
export function VoiceModeComposer({
  phase,
  utterance,
  error,
  onClearError,
  onPressMic,
  getAnalyser,
  onExit,
  attachments,
  onRemoveAttachment,
  onRetryAttachment,
  attachmentPicker,
  composerOptions,
  voiceControls,
  footer,
}: VoiceModeComposerProps) {
  return (
    <div
      className="relative z-10 isolate px-4 pb-3"
      data-testid="voice-mode-composer"
      data-phase={phase}
      // What has been heard, in every phase: shown only while listening, but
      // words over the agent are what an interruption is judged by.
      data-utterance={utterance}
    >
      {attachments.length > 0 && (
        <div className="mb-3 flex justify-center">
          <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
        </div>
      )}
      {/* The transcript line and the indicator's margin above it add up to
          the gap under the mic, so the mic sits midway between the working
          indicator and the row of controls. */}
      <div
        className="mx-auto min-h-[1.25rem] max-w-md px-2 text-center text-sm italic text-muted-foreground"
        data-testid="voice-mode-transcript"
        aria-live="polite"
      >
        {phase === 'listening' ? utterance : ''}
      </div>
      <div className="flex flex-col items-center gap-7">
        <VoiceMicButton phase={phase} getAnalyser={getAnalyser} onClick={onPressMic} />
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="justify-self-start">{attachmentPicker}</div>
          <div className="flex items-center gap-1">
            {composerOptions}
            {voiceControls}
          </div>
          <div className="justify-self-end">
            <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-[34px] w-[34px] rounded-full"
            onClick={onExit}
            aria-label="Exit voice mode"
            title="Exit voice mode"
            data-testid="voice-mode-exit"
          >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      <VoiceInputError error={error} onDismiss={onClearError} className="mt-3 justify-center" />
      {footer}
    </div>
  )
}

/** Microphone level, 0..1, smoothed for a ring that breathes rather than jitters. */
function readLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = (buffer[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / buffer.length)
  // Speech sits around 0.05–0.3 RMS; map that to most of the range.
  return Math.min(1, rms * 4)
}

function VoiceMicButton({ phase, getAnalyser, onClick }: { phase: VoiceModePhase; getAnalyser: () => AnalyserNode | null; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  // The listening ring follows the voice: one frame loop, one CSS variable.
  useEffect(() => {
    const el = buttonRef.current
    if (!el || phase !== 'listening') return
    let frame = 0
    let level = 0
    let buffer: Uint8Array<ArrayBuffer> | null = null
    const tick = () => {
      const analyser = getAnalyser()
      if (analyser) {
        if (!buffer || buffer.length !== analyser.fftSize) buffer = new Uint8Array(analyser.fftSize)
        const target = readLevel(analyser, buffer)
        level += (target - level) * (target > level ? 0.5 : 0.12)
        el.style.setProperty('--voice-level', level.toFixed(3))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.style.removeProperty('--voice-level')
    }
  }, [phase, getAnalyser])

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={MIC_LABEL[phase]}
      title={MIC_LABEL[phase]}
      data-testid="voice-mode-mic"
      data-phase={phase}
      className={cn(
        'voice-mic relative flex h-16 w-16 items-center justify-center rounded-full border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        phase === 'listening' && 'voice-mic-listening border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300',
        phase === 'speaking' && 'voice-mic-speaking border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300',
        phase === 'thinking' && 'voice-mic-thinking border-border bg-muted/60 text-muted-foreground',
      )}
    >
      <span aria-hidden className="voice-mic-ring pointer-events-none absolute inset-0 rounded-full" />
      <Mic className="relative h-6 w-6" />
    </button>
  )
}
