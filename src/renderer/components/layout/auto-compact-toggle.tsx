import { Switch } from '@renderer/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useUser } from '@renderer/context/user-context'
import { useSession, useToggleSessionAutoCompact } from '@renderer/hooks/use-sessions'

interface AutoCompactToggleProps {
  sessionId: string
  agentSlug: string
}

export function AutoCompactToggle({ sessionId, agentSlug }: AutoCompactToggleProps) {
  const { canAdminAgent } = useUser()
  const { data: session } = useSession(sessionId, agentSlug)
  const toggleAutoCompact = useToggleSessionAutoCompact()

  if (!canAdminAgent(agentSlug)) return null

  const enabled = session?.autoCompactEnabled ?? false

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <span className="text-xs text-muted-foreground">Auto-Compact</span>
            <Switch
              checked={enabled}
              onCheckedChange={(next) =>
                toggleAutoCompact.mutate({ sessionId, agentSlug, enabled: next })
              }
              aria-label="Auto-compact this session when idle"
            />
          </label>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="max-w-xs text-xs">
            When idle, rewrite this session&apos;s history so older tool I/O is
            elided and only the most recent turns are kept verbatim.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
