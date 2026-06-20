import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@shared/lib/utils'

interface ModelIconProps {
  /** Brand key from a model's catalog entry (e.g. 'anthropic'). Omit for the fallback. */
  icon?: string
  /** CSS classes applied to the icon element. */
  className?: string
}

/**
 * Renders a model's brand logo from public/model-icons/{icon}.svg, falling
 * back to a generic sparkle when the key is missing or the asset 404s.
 * Mirrors ServiceIcon's load-with-fallback pattern.
 */
export function ModelIcon({ icon, className }: ModelIconProps) {
  const [failed, setFailed] = useState(false)

  if (!icon || failed) {
    return <Sparkles className={cn('opacity-70', className)} aria-hidden="true" />
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}model-icons/${icon}.svg`}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
}
