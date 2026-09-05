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
  live: boolean
  /** Persisted row this error comes from; null for the live turn error. */
  messageId: string | null
}

interface LiveErrorState {
  isActive: boolean
  error: string | null
  apiErrorCode: string | null
  errorPresentation: ProviderErrorPresentation | null
}

interface PersistedProviderError {
  id: string
  text: string
  presentation?: ProviderErrorPresentation
}

// The last assistant row, if it is a provider error. A normal reply after it expires it.
function lastAssistantProviderError(messages: readonly ApiMessageOrBoundary[] | undefined): PersistedProviderError | null {
  if (!messages) return null
  // `messages` is the trailing page, newest last (same contract message-list relies on).
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (item.type !== 'assistant') continue
    const isProviderError =
      !!item.apiError && isProviderFacingError(item.apiError, item.errorPresentation) && !!item.content.text
    return isProviderError ? { id: item.id, text: item.content.text, presentation: item.errorPresentation } : null
  }
  return null
}

// Live error wins. Otherwise the last assistant message, if it is a provider
// error and the agent is not working again.
// The live error stays set after its row is persisted (until the next stream_start), so
// the live variant still reports that row's id and the transcript suppresses both copies.
export function currentProviderError(
  live: LiveErrorState,
  messages: readonly ApiMessageOrBoundary[] | undefined,
): CurrentProviderError | null {
  const persisted = lastAssistantProviderError(messages)
  if (live.error && isProviderFacingError(live.apiErrorCode, live.errorPresentation)) {
    return {
      message: live.error,
      presentation: live.errorPresentation ?? undefined,
      live: true,
      messageId: persisted?.id ?? null,
    }
  }
  if (live.isActive || !persisted) return null
  return { message: persisted.text, presentation: persisted.presentation, live: false, messageId: persisted.id }
}

// The current error only when a ProviderErrorPlacement renders it (placement other than
// inline), so the transcript skips that one row's inline card. Inline errors live in the
// transcript itself and never qualify; older routed rows keep their inline card.
export function currentRoutedProviderError(
  live: LiveErrorState,
  messages: readonly ApiMessageOrBoundary[] | undefined,
): CurrentProviderError | null {
  const current = currentProviderError(live, messages)
  if (!current || resolveProviderError(current.presentation).placement === 'inline') return null
  return current
}

interface ProviderErrorPlacementProps {
  placement: Placement
  sessionId: string
  agentSlug: string
  /** Everything that normally lives here, displaced while an error targets this placement. At
   *  `composer` that is the composer plus its banners (pending wake, stale session), not just the input. */
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
      <resolved.Component message={current.message} presentation={current.presentation} live={current.live}>
        {children}
      </resolved.Component>
    </div>
  )
}
