import { z } from 'zod'

import { AgentRuntimeError, agentRuntimeErrorBodySchema } from '../agent-runtime-error'

export const PROVIDER_RECONNECT_REQUIRED = 'provider_reconnect_required'

export const providerReconnectRequiredBodySchema = agentRuntimeErrorBodySchema.extend({
  code: z.literal(PROVIDER_RECONNECT_REQUIRED),
})

/**
 * The provider rejected the sign-in refresh, so only reconnecting fixes it.
 * 424, not 401: a 401 from the app API means the user's own app session expired.
 */
export class ProviderReconnectRequiredError extends AgentRuntimeError {
  readonly code = PROVIDER_RECONNECT_REQUIRED
  readonly status = 424
  protected readonly bodySchema = providerReconnectRequiredBodySchema

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderReconnectRequiredError'
  }
}
