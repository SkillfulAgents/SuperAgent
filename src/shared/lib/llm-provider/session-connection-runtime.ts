import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { findErrorInCauseChain } from '../utils/error-cause'
import { ProviderReconnectRequiredError } from '../agent-runtime-errors/provider-reconnect-required/provider-reconnect-required-error'
import { ProviderRefreshUnavailableError } from '../agent-runtime-errors/provider-refresh-unavailable/provider-refresh-unavailable-error'
import { connectionRuntime, type ConnectionRuntime } from './connection-runtime'
import type { ResolvedConnection } from './connections'

// The container's own credential endpoint (llm-runtime.ts) keeps CredentialRefreshError;
// these wrappers are for the user-facing session start/send path only.

/** A failed sign-in refresh becomes an AgentRuntimeError the user can act on. */
export async function sessionConnectionRuntime(resolved: ResolvedConnection, agentId: string): Promise<ConnectionRuntime> {
  try {
    return await connectionRuntime(resolved, agentId)
  } catch (error) {
    const refresh = findErrorInCauseChain(error, CredentialRefreshError)
    if (!refresh) throw error
    throw refresh.status === 401
      ? new ProviderReconnectRequiredError(refresh.message, { cause: error })
      : new ProviderRefreshUnavailableError(refresh.message, { cause: error })
  }
}

/** A signed-out default provider must not block a session on another provider; it just isn't prewarmed. */
export async function prewarmConnectionRuntime(resolved: ResolvedConnection, agentId: string): Promise<ConnectionRuntime | undefined> {
  try {
    return await connectionRuntime(resolved, agentId)
  } catch (error) {
    if (findErrorInCauseChain(error, CredentialRefreshError)) return undefined
    throw error
  }
}
