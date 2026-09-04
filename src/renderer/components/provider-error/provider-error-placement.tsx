import { useMemo } from 'react'

import type {
  ProviderErrorPlacement as Placement,
  ProviderErrorPresentation,
} from '@shared/lib/llm-provider/error-presentation'
import { PROVIDER_ERROR_CODES, type ApiMessageOrBoundary } from '@shared/lib/types/api'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'

import { resolveProviderError } from './provider-error-registry'

export interface CurrentProviderError {
  message: string
  presentation?: ProviderErrorPresentation
}

interface LiveErrorState {
  isActive: boolean
  error: string | null
  apiErrorCode: string | null
  errorPresentation: ProviderErrorPresentation | null
}

// Live error wins. Otherwise the last assistant message, if it is a provider
// error and the agent is not working again. A normal reply after it expires it.
export function currentProviderError(
  live: LiveErrorState,
  messages: readonly ApiMessageOrBoundary[] | undefined,
): CurrentProviderError | null {
  if (live.error && live.apiErrorCode && PROVIDER_ERROR_CODES.has(live.apiErrorCode)) {
    return { message: live.error, presentation: live.errorPresentation ?? undefined }
  }
  if (live.isActive || !messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (item.type !== 'assistant') continue
    const isProviderError = !!item.apiError && PROVIDER_ERROR_CODES.has(item.apiError) && !!item.content.text
    return isProviderError ? { message: item.content.text, presentation: item.errorPresentation } : null
  }
  return null
}

interface ProviderErrorPlacementProps {
  placement: Placement
  sessionId: string
  agentSlug: string
}

// Renders the session's current provider error iff its presentation targets this placement.
export function ProviderErrorPlacement({ placement, sessionId, agentSlug }: ProviderErrorPlacementProps) {
  const { isActive, error, apiErrorCode, errorPresentation } = useMessageStream(sessionId, agentSlug)
  const { data: messages } = useMessages(sessionId, agentSlug)
  const current = useMemo(
    () => currentProviderError({ isActive, error, apiErrorCode, errorPresentation }, messages),
    [isActive, error, apiErrorCode, errorPresentation, messages],
  )
  if (!current) return null
  const resolved = resolveProviderError(current.presentation)
  if (resolved.placement !== placement) return null
  return (
    <div className="px-4 pb-2" data-testid={`provider-error-placement-${placement}`}>
      <resolved.Component message={current.message} presentation={current.presentation} />
    </div>
  )
}
