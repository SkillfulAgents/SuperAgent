import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils'

interface ModelIconProps {
  /** Brand key from a model's catalog entry (e.g. 'anthropic'). Omit for the fallback. */
  icon?: string
  /** CSS classes applied to the icon element. */
  className?: string
}

const UPLOADED_ICON_PREFIX = 'uploaded:'

function getModelIconSrc(icon: string): string {
  if (icon.startsWith(UPLOADED_ICON_PREFIX)) {
    const fileName = icon.slice(UPLOADED_ICON_PREFIX.length)
    return `${getApiBaseUrl()}/api/settings/model-icons/${encodeURIComponent(fileName)}`
  }
  return `${import.meta.env.BASE_URL}model-icons/${icon}.svg`
}

/**
 * Renders a model's brand logo from either a bundled icon key or an uploaded
 * data-dir icon, falling back to a generic sparkle when the asset is missing.
 */
export function ModelIcon({ icon, className }: ModelIconProps) {
  const [failed, setFailed] = useState(false)

  if (!icon || failed) {
    return <Sparkles className={cn('opacity-70', className)} aria-hidden="true" />
  }

  return (
    <img
      src={getModelIconSrc(icon)}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
}
