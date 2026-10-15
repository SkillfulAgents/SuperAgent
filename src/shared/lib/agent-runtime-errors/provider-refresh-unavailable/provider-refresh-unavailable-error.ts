import { z } from 'zod'

import { AgentRuntimeError, agentRuntimeErrorBodySchema } from '../agent-runtime-error'

export const PROVIDER_REFRESH_UNAVAILABLE = 'provider_refresh_unavailable'

export const providerRefreshUnavailableBodySchema = agentRuntimeErrorBodySchema.extend({
  code: z.literal(PROVIDER_REFRESH_UNAVAILABLE),
})

/** The sign-in refresh could not be checked right now; retrying later can succeed. */
export class ProviderRefreshUnavailableError extends AgentRuntimeError {
  readonly code = PROVIDER_REFRESH_UNAVAILABLE
  readonly status = 503
  protected readonly bodySchema = providerRefreshUnavailableBodySchema

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderRefreshUnavailableError'
  }

  protected override headers(): Record<string, string> {
    return { 'Retry-After': '30' }
  }
}
