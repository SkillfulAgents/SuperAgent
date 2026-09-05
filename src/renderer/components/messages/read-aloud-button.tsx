import { Loader2, Square, Volume2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useIsTtsConfigured } from '@renderer/hooks/use-voice-input'
import { useReadAloud } from '@renderer/hooks/use-read-aloud'
import { cn } from '@shared/lib/utils/cn'

interface ReadAloudButtonProps {
  messageId: string
  /** The message's Markdown; what gets spoken. */
  markdown: string
  className?: string
}

/**
 * Speaker toggle under an assistant reply. Hidden entirely when the voice
 * provider can't synthesize speech, so the row costs nothing for users
 * without it set up.
 */
export function ReadAloudButton({ messageId, markdown, className }: ReadAloudButtonProps) {
  const configured = useIsTtsConfigured()
  const { status, toggle, error } = useReadAloud(messageId, markdown)
  if (!configured) return null

  const label = status === 'idle' ? 'Read aloud' : 'Stop reading'
  const Icon = status === 'connecting' ? Loader2 : status === 'speaking' ? Square : Volume2

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            aria-pressed={status !== 'idle'}
            data-testid="read-aloud-button"
            data-status={status}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors',
              'hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]',
              status !== 'idle' && 'text-foreground',
              className,
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', status === 'connecting' && 'animate-spin', status === 'speaking' && 'fill-current')} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{error ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
