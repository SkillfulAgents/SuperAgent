import { cn } from '@shared/lib/utils/cn'

export const FEATURED_SERVICE_SLUGS = [
  'gmail',
  'slack',
  'notion',
  'github',
  'linear',
  'figma',
  'atlassian',
] as const

interface FeaturedServicesStackProps {
  /** Tile size: `sm` (h-8) for tight rows, `md` (h-9) for empty-state hero. */
  size?: 'sm' | 'md'
  className?: string
}

export function FeaturedServicesStack({ size = 'sm', className }: FeaturedServicesStackProps) {
  const tile = size === 'md' ? 'h-9 w-9' : 'h-8 w-8'
  const icon = size === 'md' ? 'h-5 w-5' : 'h-4 w-4'
  const overlap = size === 'md' ? -10 : -8

  return (
    <div className={cn('flex items-center', className)} aria-hidden="true">
      {FEATURED_SERVICE_SLUGS.map((slug, i) => (
        <div
          key={slug}
          className={cn(
            tile,
            'rounded-lg border border-border bg-background flex items-center justify-center shadow-sm transition-transform duration-100 ease-out hover:scale-110 hover:z-10',
          )}
          style={{ marginLeft: i === 0 ? 0 : overlap, zIndex: i }}
        >
          <img
            src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
            alt=""
            className={cn(icon, 'object-contain')}
          />
        </div>
      ))}
      <div
        className={cn(
          tile,
          'rounded-lg border border-border bg-background flex items-center justify-center shadow-sm',
        )}
        style={{ marginLeft: overlap, zIndex: FEATURED_SERVICE_SLUGS.length }}
      >
        <span className="text-2xs font-medium text-muted-foreground/70">70+</span>
      </div>
    </div>
  )
}
