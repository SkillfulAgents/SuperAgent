import type { ComponentType, ReactNode } from 'react'

import {
  errorPlacement,
  type ProviderErrorPlacement,
  type ProviderErrorPresentation,
} from '@shared/lib/llm-provider/error-presentation'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'

export interface ProviderErrorComponentProps {
  message: string
  presentation?: ProviderErrorPresentation
  /** Content this error displaced (the composer, at `composer`). Render it to give it back. */
  children?: ReactNode
}

export const DEFAULT_ERROR_COMPONENT = 'default'

// `errorPresentation.component` → component. Adding an error component = one row here.
const REGISTRY: Record<string, ComponentType<ProviderErrorComponentProps>> = {
  [DEFAULT_ERROR_COMPONENT]: ProviderErrorCard,
}

export interface ResolvedProviderError {
  Component: ComponentType<ProviderErrorComponentProps>
  placement: ProviderErrorPlacement
}

// Unknown keys fall back to the default so an older client never drops a server-authored error.
export function resolveProviderError(presentation: ProviderErrorPresentation | null | undefined): ResolvedProviderError {
  const key = presentation?.component ?? DEFAULT_ERROR_COMPONENT
  return {
    Component: REGISTRY[key] ?? REGISTRY[DEFAULT_ERROR_COMPONENT],
    placement: errorPlacement(presentation),
  }
}
