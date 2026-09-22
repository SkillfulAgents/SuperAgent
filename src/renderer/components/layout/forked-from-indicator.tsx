import { useEffect, useRef, useState } from 'react'
import { Split } from 'lucide-react'
import { AppLink } from '@renderer/components/ui/app-link'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

/** Grace period for the pointer to cross the gap between the icon and the popover. */
const CLOSE_DELAY_MS = 150

interface ForkedFromIndicatorProps {
  agentSlug: string
  sourceSessionId: string
  /** Absent when the source conversation has been deleted. */
  sourceSessionName?: string | null
}

/**
 * The fork icon next to a forked session's name in the header. Driven by the
 * session metadata, so it shows wherever the thread is scrolled; the in-thread
 * fork line only renders while the copied history is loaded. Opens on hover
 * for a mouse, and on click for touch and keyboard.
 */
export function ForkedFromIndicator({ agentSlug, sourceSessionId, sourceSessionName }: ForkedFromIndicatorProps) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A click right after hovering would otherwise toggle the popover shut.
  const openedByHover = useRef(false)

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  useEffect(() => cancelClose, [])

  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    cancelClose()
    if (!open) openedByHover.current = true
    setOpen(true)
  }
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    cancelClose()
    closeTimer.current = setTimeout(() => {
      openedByHover.current = false
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }
  const onOpenChange = (next: boolean) => {
    cancelClose()
    if (!next) openedByHover.current = false
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Branched conversation"
          className="ml-1.5 inline-flex items-center align-middle text-muted-foreground transition-colors hover:text-foreground app-no-drag"
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onClick={(e) => {
            if (!openedByHover.current) return
            e.preventDefault()
            openedByHover.current = false
          }}
          data-testid="forked-from-indicator"
        >
          <Split className="h-3.5 w-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-xs px-3 py-2 text-xs text-muted-foreground"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // Hovering should not pull focus out of the composer.
        onOpenAutoFocus={(e) => {
          if (openedByHover.current) e.preventDefault()
        }}
        data-testid="forked-from-popover"
      >
        Branched from{' '}
        {sourceSessionName ? (
          <AppLink
            to="/agents/$slug/sessions/$sessionId"
            params={{ slug: agentSlug, sessionId: sourceSessionId }}
            onClick={() => onOpenChange(false)}
            className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
            data-testid="forked-from-link"
          >
            {sourceSessionName}
          </AppLink>
        ) : (
          'a deleted conversation'
        )}
      </PopoverContent>
    </Popover>
  )
}
