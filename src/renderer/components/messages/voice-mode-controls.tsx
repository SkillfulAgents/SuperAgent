import type { ReactNode } from 'react'
import { Music2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ReadAloudSpeedSelect } from './read-aloud-controls'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { resolveHoldSound } from '@shared/lib/voice/tts-preferences'
import { cn } from '@shared/lib/utils/cn'

/** The person's own hold-sound preference, as voice mode applies it. */
export function useHoldSoundPreference(): boolean {
  const { data: userSettings } = useUserSettings()
  return resolveHoldSound(userSettings?.voice?.holdSound)
}

/**
 * A square toggle in voice mode's action row, the size of the exit beside it,
 * with the row's instant tooltip below. The label names what a click does.
 */
export function VoiceToggleButton({ label, pressed, onClick, testId, className, children }: {
  label: string
  pressed: boolean
  onClick: () => void
  testId: string
  className?: string
  children: ReactNode
}) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className={cn('h-[34px] w-[34px]', className)}
            onClick={onClick}
            aria-pressed={pressed}
            aria-label={label}
            data-testid={testId}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The controls under the mic that are voice mode's own: the reading speed
 * and the hold sound, both written to the person's settings so they hold
 * across sessions.
 */
export function VoiceModeControls({ showSpeed = true }: { showSpeed?: boolean }) {
  const holdSound = useHoldSoundPreference()
  const updateUserSettings = useUpdateUserSettings()

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex items-center gap-2" data-testid="voice-mode-controls">
        {showSpeed && <ReadAloudSpeedSelect testId="voice-mode-speed" align="center" />}
        <VoiceToggleButton
          label={holdSound ? 'Mute hold music' : 'Unmute hold music'}
          pressed={holdSound}
          testId="voice-mode-hold-sound"
          // From the settings as they are when the write runs, not as
          // shown: two quick clicks toggle twice rather than cancel out.
          onClick={() => updateUserSettings.mutate((current) => ({ voice: { holdSound: !resolveHoldSound(current.voice?.holdSound) } }))}
          // Muted reads as off.
          className={holdSound ? 'text-foreground' : 'text-muted-foreground/60'}
        >
          <Music2 className="h-4 w-4" />
        </VoiceToggleButton>
      </div>
    </TooltipProvider>
  )
}
