import { AudioLines } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useCanUseVoiceMode } from '@renderer/hooks/use-voice-input'

interface VoiceModeButtonProps {
  onClick: () => void
  disabled?: boolean
  className?: string
  /**
   * `default` (filled) while voice mode is the composer's primary action —
   * i.e. there is nothing to send yet. `outline` once Send takes that slot.
   */
  variant?: 'outline' | 'default'
}

/**
 * Enters voice mode (talk to the agent, hear its replies). Rendered only
 * when the configured voice provider can both transcribe and speak — a
 * dictation-only setup keeps just the mic.
 */
export function VoiceModeButton({ onClick, disabled, className = 'h-[34px] w-[34px]', variant = 'outline' }: VoiceModeButtonProps) {
  const canUseVoiceMode = useCanUseVoiceMode()
  if (!canUseVoiceMode) return null
  return (
    <Button
      type="button"
      size="icon"
      variant={variant}
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label="Voice mode"
      title="Voice mode"
      data-testid="voice-mode-button"
    >
      <AudioLines className="h-4 w-4" />
    </Button>
  )
}
