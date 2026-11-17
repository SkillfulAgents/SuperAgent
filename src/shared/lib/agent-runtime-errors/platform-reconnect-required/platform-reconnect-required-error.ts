import { z } from 'zod'

import { AgentRuntimeError, agentRuntimeErrorBodySchema } from '../agent-runtime-error'

export const PLATFORM_RECONNECT_REQUIRED = 'platform_reconnect_required'

export const platformReconnectRequiredBodySchema = agentRuntimeErrorBodySchema.extend({
  code: z.literal(PLATFORM_RECONNECT_REQUIRED),
})

/**
 * The platform rejected this app's platform key (revoked, replaced by a newer
 * sign-in, or the member is gone), so only reconnecting the platform fixes it.
 * 424, not 401: a 401 from the app API means the user's own app session expired.
 */
export class PlatformReconnectRequiredError extends AgentRuntimeError {
  readonly code = PLATFORM_RECONNECT_REQUIRED
  readonly status = 424
  protected readonly bodySchema = platformReconnectRequiredBodySchema

  constructor(message: string) {
    super(message)
    this.name = 'PlatformReconnectRequiredError'
  }
}
