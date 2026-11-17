import { cn } from '@shared/lib/utils/cn'

/** Marks someone who isn't on Gamut yet: a team-directory person, or an invited account nobody has claimed. */
export function NotOnGamutBadge({ label = 'Not on Gamut', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border border-dashed border-muted-foreground/50 px-1.5 text-[10px] leading-4 text-muted-foreground',
        className,
      )}
      data-testid="not-on-gamut-badge"
    >
      {label}
    </span>
  )
}
