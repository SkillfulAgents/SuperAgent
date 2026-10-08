import { CredentialRefreshError, PROVIDER_SIGN_IN_EXPIRED } from '../../../../agent-container/src/credential-refresh-error'
import type { ProviderErrorPresentation } from './error-presentation'

const RECONNECT_CARD_MESSAGE = `${PROVIDER_SIGN_IN_EXPIRED} [Reconnect in Settings → Model Providers](/settings/llm).`

export type CredentialRefreshErrorCode = 'provider_reconnect_required' | 'provider_refresh_unavailable'

/** Session start/send wrap the refresh failure (e.g. MessageNotAcceptedError), so walk `cause`. */
export function findCredentialRefreshError(error: unknown): CredentialRefreshError | null {
  const seen = new Set<unknown>()
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof CredentialRefreshError) return current
    seen.add(current)
  }
  return null
}

export function credentialRefreshErrorBody(error: CredentialRefreshError): {
  error: string
  code: CredentialRefreshErrorCode
  errorPresentation: ProviderErrorPresentation
} {
  const reconnect = error.status === 401
  return {
    error: error.message,
    code: reconnect ? 'provider_reconnect_required' : 'provider_refresh_unavailable',
    errorPresentation: {
      severity: reconnect ? 'error' : 'warning',
      message: reconnect ? RECONNECT_CARD_MESSAGE : error.message,
      icon: reconnect ? 'info' : 'triangle-alert',
    },
  }
}

/** Browser-facing status. A 401 from the app API means "the user's app session expired" and signs them out. */
export function credentialRefreshUserStatus(error: CredentialRefreshError): 424 | 503 {
  return error.status === 401 ? 424 : 503
}

export function credentialRefreshHeaders(error: CredentialRefreshError): Record<string, string> {
  return error.status === 503 ? { 'Retry-After': '30' } : {}
}
