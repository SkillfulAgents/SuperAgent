import type { ComponentType } from 'react'

import { AgentRuntimeRequestError } from './agent-runtime-request-error'
import { PROVIDER_RECONNECT_REQUIRED } from './provider-reconnect-required/provider-reconnect-required-error'
import { ProviderReconnectRequiredPreview } from './provider-reconnect-required/provider-reconnect-required-preview'
import { PROVIDER_REFRESH_UNAVAILABLE } from './provider-refresh-unavailable/provider-refresh-unavailable-error'
import { ProviderRefreshUnavailablePreview } from './provider-refresh-unavailable/provider-refresh-unavailable-preview'

export interface AgentRuntimeErrorPreviewProps {
  error: AgentRuntimeRequestError
}

// Client only: AgentRuntimeError `code` → its preview, which lives in that error's folder.
// Server code must not import this file. Codes without a row keep the global toast.
const PREVIEWS: Partial<Record<string, ComponentType<AgentRuntimeErrorPreviewProps>>> = {
  [PROVIDER_RECONNECT_REQUIRED]: ProviderReconnectRequiredPreview,
  [PROVIDER_REFRESH_UNAVAILABLE]: ProviderRefreshUnavailablePreview,
}

export function resolveAgentRuntimeErrorPreview(error: unknown): ComponentType<AgentRuntimeErrorPreviewProps> | undefined {
  return error instanceof AgentRuntimeRequestError ? PREVIEWS[error.code] : undefined
}
