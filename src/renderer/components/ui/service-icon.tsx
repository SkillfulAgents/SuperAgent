import { useState } from 'react'
import { ExternalLink, Plug, Link2, type LucideIcon } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

type FallbackType = 'oauth' | 'mcp' | 'request'

const FALLBACK_ICONS: Record<FallbackType, LucideIcon> = {
  oauth: ExternalLink,
  mcp: Plug,
  request: Link2,
}

interface ServiceIconProps {
  /** The service slug (e.g., 'gmail', 'slack', 'github') */
  slug: string
  /** Which generic icon to show when no service icon is found */
  fallback?: FallbackType
  /** CSS classes applied to the icon element */
  className?: string
}

/**
 * Renders a service-specific logo from public/service-icons/{slug}.svg,
 * falling back to a generic lucide-react icon if the file doesn't exist.
 */
export function ServiceIcon({ slug, fallback = 'oauth', className }: ServiceIconProps) {
  const [failed, setFailed] = useState(false)

  if (!slug || failed) {
    const Icon = FALLBACK_ICONS[fallback]
    return <Icon className={className} />
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
}
