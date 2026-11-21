import { useId, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

export function ChannelAction({ action, title, reason, onSetup, quiet = false, icon, iconOnly = false, label, hint }: {
  action: string; title: string; reason?: string; onSetup: () => void
  /**
   * A state rather than a call to act (a channel saved for later): a plain,
   * muted button that still opens setup when clicked.
   */
  quiet?: boolean
  icon?: ReactNode
  /** Just the icon, a square the composer's size, its words in a tooltip (a channel tile). */
  iconOnly?: boolean
  /** The accessible name, when "{action} {title}" would not read as one. */
  label?: string
  /** What the tooltip says when nothing is in the way (`reason` wins); defaults to "{action} {title}" for an icon. */
  hint?: string
}) {
  const [showTip, setShowTip] = useState(false)
  const reasonId = useId()
  const tip = reason ?? (iconOnly ? hint ?? `${action} ${title}` : undefined)
  return <Tooltip open={!!tip && showTip} onOpenChange={setShowTip}>
    <TooltipTrigger asChild>
      <Button type="button" size={iconOnly ? 'icon' : 'sm'} variant={quiet ? 'ghost' : 'outline'} aria-label={label ?? `${action} ${title}`}
        aria-disabled={!!reason} aria-describedby={reason ? reasonId : undefined}
        title={reason || iconOnly ? undefined : hint}
        className={cn(
          'aria-disabled:cursor-help aria-disabled:opacity-50',
          iconOnly && 'size-7 shrink-0',
          quiet && 'font-normal text-muted-foreground hover:text-foreground',
        )}
        onClick={event => {
          if (reason) {
            event.preventDefault()
            setShowTip(true)
          } else {
            // Its tooltip would outlive the click behind the dialog this
            // opens, and take that dialog's Escape.
            setShowTip(false)
            onSetup()
          }
        }}>
        {icon}
        {!iconOnly && action}
      </Button>
    </TooltipTrigger>
    {reason && <span id={reasonId} hidden>{reason}</span>}
    {tip && <TooltipContent align="end" className="max-w-72">{tip}</TooltipContent>}
  </Tooltip>
}
