import { useId, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'

export function ChannelAction({ action, title, reason, onSetup }: {
  action: string; title: string; reason?: string; onSetup: () => void
}) {
  const [showReason, setShowReason] = useState(false)
  const reasonId = useId()
  return <Tooltip open={!!reason && showReason} onOpenChange={setShowReason}>
    <TooltipTrigger asChild>
      <Button type="button" size="sm" variant="outline" aria-label={`${action} ${title}`}
        aria-disabled={!!reason} aria-describedby={reason ? reasonId : undefined}
        className="aria-disabled:cursor-help aria-disabled:opacity-50"
        onClick={event => {
          if (reason) {
            event.preventDefault()
            setShowReason(true)
          } else {
            onSetup()
          }
        }}>
        {action}
      </Button>
    </TooltipTrigger>
    {reason && <>
      <span id={reasonId} hidden>{reason}</span>
      <TooltipContent align="end" className="max-w-72">{reason}</TooltipContent>
    </>}
  </Tooltip>
}
