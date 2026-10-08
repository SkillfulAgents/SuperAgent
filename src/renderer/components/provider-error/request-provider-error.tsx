import { ProviderRequestError } from '@renderer/lib/provider-request-error'

import { resolveProviderError } from './provider-error-registry'

/** Shows a provider error from a failed start/send request, which never reaches the turn stream. */
export function RequestProviderError({ error, className }: { error: unknown; className?: string }) {
  if (!(error instanceof ProviderRequestError)) return null
  const { Component } = resolveProviderError(error.presentation)
  return (
    <div className={className}>
      <Component message={error.message} presentation={error.presentation} dismissible />
    </div>
  )
}
