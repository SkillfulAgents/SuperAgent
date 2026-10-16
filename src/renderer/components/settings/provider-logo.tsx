import { Globe } from 'lucide-react'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { cn } from '@shared/lib/utils/cn'
import type { LlmProviderId } from '@shared/lib/llm-provider/provider-types'

// Tints a bundled monochrome brand glyph (same mask approach as the Usage tab). `color` defaults to the
// text color, so marks whose brand is black/white follow the theme.
// provider-icons/ holds Simple Icons glyphs (CC0): anthropic/openrouter from 16.32.0, aws from 10.x (removed
// later) recolored to AWS's squid-ink wordmark and orange smile. model-icons/anthropic.svg is the Claude spark;
// provider-icons/gamut.svg is the Gamut logomark (build/icon.icon).
function BrandMark({ src, color = 'currentColor', className }: { src: string; color?: string; className: string }) {
  const url = `url("${import.meta.env.BASE_URL}${src}")`
  return (
    <span
      className={cn('shrink-0 text-foreground', className)}
      style={{ backgroundColor: color, maskImage: url, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskImage: url, WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }}
      aria-hidden="true"
    />
  )
}

/** Every provider's glyph, for the monochrome variant. */
const GLYPHS: Record<Exclude<LlmProviderId, 'generic'>, string> = {
  platform: 'provider-icons/gamut.svg',
  anthropic: 'provider-icons/anthropic.svg',
  'claude-subscription': 'model-icons/anthropic.svg',
  'grok-subscription': 'model-icons/xai.svg',
  'codex-subscription': 'model-icons/openai.svg',
  'kimi-subscription': 'model-icons/kimi.svg',
  'minimax-subscription': 'model-icons/minimax.svg',
  bedrock: 'provider-icons/aws.svg',
  openrouter: 'provider-icons/openrouter.svg',
}

/**
 * Provider logos in brand color. Anthropic, xAI, OpenAI and Gamut marks are black/white, so they follow the theme.
 * `monochrome` draws every mark in the text color instead (compact lists such as the model picker).
 */
export function ProviderLogo({ provider, className = 'h-5 w-5', monochrome = false }: { provider: LlmProviderId; className?: string; monochrome?: boolean }) {
  if (monochrome) {
    return provider === 'generic'
      ? <Globe className={cn('shrink-0', className)} aria-hidden="true" />
      : <BrandMark src={GLYPHS[provider]} className={className} />
  }
  switch (provider) {
    case 'platform':
      return <BrandMark src="provider-icons/gamut.svg" className={className} />
    case 'anthropic':
      return <BrandMark src="provider-icons/anthropic.svg" className={className} />
    case 'claude-subscription':
      return <BrandMark src="model-icons/anthropic.svg" color="#D97757" className={className} />
    case 'grok-subscription':
      return <ModelIcon icon="xai" className={cn('shrink-0', className)} />
    case 'codex-subscription':
      return <ModelIcon icon="openai" className={cn('shrink-0', className)} />
    case 'kimi-subscription':
      return <ModelIcon icon="kimi" className={cn('shrink-0', className)} />
    case 'minimax-subscription':
      return <ModelIcon icon="minimax" className={cn('shrink-0', className)} />
    case 'bedrock':
      return <img src={`${import.meta.env.BASE_URL}provider-icons/aws.svg`} alt="" aria-hidden="true" className={cn('shrink-0 object-contain', className)} />
    case 'openrouter':
      return <BrandMark src="provider-icons/openrouter.svg" color="#94A3B8" className={className} />
    case 'generic':
      return <Globe className={cn('shrink-0 text-sky-500', className)} aria-hidden="true" />
  }
}
