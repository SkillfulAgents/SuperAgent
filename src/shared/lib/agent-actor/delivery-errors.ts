/**
 * The errors a delivery or a session start throws, for callers that branch on
 * them. A caller reads them with `deliveryFailure` / `startFailure`, never
 * `instanceof`: an actor behind a transport hands back the name and the
 * fields, not the class.
 */

/**
 * Why a message did not go through.
 * - `session-gone`: the container has no such session.
 * - `unavailable`: the container, the provider or the stream could not be reached before the send.
 * - `rejected`: the container refused the message.
 * - `provider-not-attached`: the caller may bind its provider only while the session holds it, and it no longer does.
 * - `unknown`: the send failed after it left; the container may have the message.
 */
export type DeliveryErrorCode = 'session-gone' | 'unavailable' | 'rejected' | 'provider-not-attached' | 'unknown'

export class DeliveryError extends Error {
  override readonly name = 'DeliveryError'
  /** false: the message certainly did not reach the agent, so it is safe to send again. */
  readonly accepted: false | 'unknown'
  /** The container's HTTP status, when it refused the message with one. */
  readonly status?: number

  constructor(readonly code: DeliveryErrorCode, message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options)
    this.accepted = code === 'unknown' ? 'unknown' : false
    if (options?.status !== undefined) this.status = options.status
  }
}

/** Where a session start failed. Past `create`, the container's session is revoked. */
export type StartErrorCode = 'create-failed' | 'created-late' | 'attach-failed' | 'register-failed'

export class StartError extends Error {
  override readonly name = 'StartError'

  constructor(readonly code: StartErrorCode, readonly revoked: boolean, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export interface DeliveryFailure {
  code: DeliveryErrorCode
  accepted: false | 'unknown'
  status?: number
}

export interface StartFailure {
  code: StartErrorCode
  revoked: boolean
}

/** The delivery failure an error reports, or null when it is not one. */
export function deliveryFailure(error: unknown): DeliveryFailure | null {
  if (!isNamed(error, 'DeliveryError')) return null
  const { code, accepted, status } = error as unknown as DeliveryFailure
  return { code, accepted, ...(status !== undefined ? { status } : {}) }
}

/** The start failure an error reports, or null when it is not one. */
export function startFailure(error: unknown): StartFailure | null {
  if (!isNamed(error, 'StartError')) return null
  const { code, revoked } = error as unknown as StartFailure
  return { code, revoked }
}

function isNamed(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name
}
