import type { ReactNode } from 'react'

interface SectionHeaderProps {
  title: string
  /** Right-aligned controls (e.g. a sort popover or a dropdown). */
  actions?: ReactNode
}

/**
 * Muted section heading with a divider, used to head non-collapsible sections
 * (e.g. cron Run History). Renders as a fragment so the caller's container
 * controls outer spacing.
 */
export function SectionHeader({ title, actions }: SectionHeaderProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground flex-1">{title}</h3>
        {actions}
      </div>
      <div className="border-b mt-2" />
    </>
  )
}
