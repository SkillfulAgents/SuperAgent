import { X } from 'lucide-react'
import { useInterruptSession } from '@renderer/hooks/use-messages'
import { cn } from '@shared/lib/utils/cn'

interface StopSessionButtonProps {
  sessionId: string
  agentSlug: string
}

export function StopSessionButton({ sessionId, agentSlug }: StopSessionButtonProps) {
  const interrupt = useInterruptSession()

  return (
    <button
      type="button"
      onClick={() => interrupt.mutate({ sessionId, agentSlug })}
      disabled={interrupt.isPending}
      aria-label="Stop session"
      title="Stop session"
      data-testid="request-stop-session"
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded text-foreground transition-colors',
        interrupt.isPending ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted'
      )}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}
