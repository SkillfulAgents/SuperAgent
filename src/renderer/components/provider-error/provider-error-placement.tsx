import { useMemo, useState, type ReactNode } from 'react'

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
  /** Everything that normally lives here. At `composer` that is the composer plus its banners.
   *  Pass a function to learn when the current error withholds it, so voice can pause. */
  children?: ReactNode | ((slot: ProviderErrorSlot) => ReactNode)
}

export interface ProviderErrorSlot {
  /** True while the current error withholds the slot; it stays mounted, hidden. */
  displaced: boolean
}

// Renders the session's current provider error above children when its presentation
// targets this placement. Children keep one tree position whether or not an error is
// showing: the composer hosts voice mode, and a remount would drop it (SUP-890). A card
// that must withhold children (paywall while blocked) hides the slot instead.
export function ProviderErrorPlacement({ placement, sessionId, agentSlug, children }: ProviderErrorPlacementProps) {
  const { isActive, error, apiErrorCode, errorPresentation } = useMessageStream(sessionId, agentSlug)
  const { data: messages } = useMessages(sessionId, agentSlug)
  const [displaced, setDisplaced] = useState(false)
  const current = useMemo(
    () => currentProviderError({ isActive, error, apiErrorCode, errorPresentation }, messages),
    [isActive, error, apiErrorCode, errorPresentation, messages],
  )
  const resolved = current ? resolveProviderError(current.presentation) : null
  const showing = current !== null && resolved !== null && resolved.placement === placement
  const slot: ProviderErrorSlot = { displaced: showing && displaced }
  return (
    <div data-testid={showing ? `provider-error-placement-${placement}` : undefined}>
      {showing && (
        <resolved.Component
          message={current.message}
          presentation={current.presentation}
          live={current.live}
          onDisplaceChildren={setDisplaced}
        />
      )}
      <div hidden={slot.displaced}>{typeof children === 'function' ? children(slot) : children}</div>
    </div>
  )
}
