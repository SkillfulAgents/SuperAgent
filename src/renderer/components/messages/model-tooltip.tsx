import { useRef, useState, type ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { connectionLabel } from '@renderer/components/settings/provider-select'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'

export function ModelTooltip({ line, connection, children }: {
  line: string | undefined
  connection?: ConnectionInfo
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (!line) return children
  return (
    <TooltipProvider>
      {/* A Radix popover trigger carries aria-expanded while its menu is open; never open over it. */}
      <Tooltip open={open} onOpenChange={next => setOpen(next && triggerRef.current?.getAttribute('aria-expanded') !== 'true')}>
        <TooltipTrigger asChild ref={triggerRef}>{children}</TooltipTrigger>
        <TooltipContent className="max-w-60 break-words">
          <div>{line}</div>
          {connection && <div className="opacity-70">{connectionLabel(connection)}</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
