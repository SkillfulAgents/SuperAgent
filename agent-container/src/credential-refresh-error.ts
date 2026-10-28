export const PROVIDER_SIGN_IN_EXPIRED = 'Provider sign-in expired or was revoked.'

/** Safe, shared failure contract between the app credential service and proxy. */
export class CredentialRefreshError extends Error {
  constructor(readonly status: 401 | 503 = 503) {
    super(status === 401
      ? `${PROVIDER_SIGN_IN_EXPIRED} Please reconnect in Settings → Model Providers.`
      : 'Provider sign-in refresh is temporarily unavailable. Please retry shortly.')
  }
}
