import { cn } from '@shared/lib/utils/cn'
import { TileStack } from '@renderer/components/ui/tile-stack'

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
  const icon = size === 'md' ? 'h-5 w-5' : 'h-4 w-4'

  return (
    <TileStack size={size} overflowLabel="70+" className={className}>
      {FEATURED_SERVICE_SLUGS.map((slug) => (
        <img
          key={slug}
          src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
          alt=""
          className={cn(icon, 'object-contain')}
        />
      ))}
    </TileStack>
  )
}
