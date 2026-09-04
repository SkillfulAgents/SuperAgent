import { useMemo, type ReactNode } from 'react'

import type {
  ProviderErrorPlacement as Placement,
  ProviderErrorPresentation,
} from '@shared/lib/llm-provider/error-presentation'
import { isProviderFacingError, type ApiMessageOrBoundary } from '@shared/lib/types/api'
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
  if (live.error && isProviderFacingError(live.apiErrorCode, live.errorPresentation)) {
    return { message: live.error, presentation: live.errorPresentation ?? undefined }
  }
  if (live.isActive || !messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (item.type !== 'assistant') continue
    const isProviderError =
      !!item.apiError && isProviderFacingError(item.apiError, item.errorPresentation) && !!item.content.text
    return isProviderError ? { message: item.content.text, presentation: item.errorPresentation } : null
  }
  return null
}

interface ProviderErrorPlacementProps {
  placement: Placement
  sessionId: string
  agentSlug: string
  /** What normally lives here (e.g. the composer). Displaced while an error targets this placement. */
  children?: ReactNode
}

// Renders children, or the session's current provider error in their place when
// its presentation targets this placement. The component gets the displaced
// children and renders them back once it is resolved.
export function ProviderErrorPlacement({ placement, sessionId, agentSlug, children }: ProviderErrorPlacementProps) {
  const { isActive, error, apiErrorCode, errorPresentation } = useMessageStream(sessionId, agentSlug)
  const { data: messages } = useMessages(sessionId, agentSlug)
  const current = useMemo(
    () => currentProviderError({ isActive, error, apiErrorCode, errorPresentation }, messages),
    [isActive, error, apiErrorCode, errorPresentation, messages],
  )
  const resolved = current ? resolveProviderError(current.presentation) : null
  if (!current || !resolved || resolved.placement !== placement) return <>{children}</>
  return (
    <div data-testid={`provider-error-placement-${placement}`}>
      <resolved.Component message={current.message} presentation={current.presentation}>
        {children}
      </resolved.Component>
    </div>
  )
}
