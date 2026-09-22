/** Raised only where the host knows no runtime input was accepted. Do not infer
 * this from arbitrary HTTP 5xx bodies or a lost/timeout response. */
export class MessageNotAcceptedError extends Error {
  constructor(readonly reason: 'session-gone' | 'unavailable', message: string, options?: ErrorOptions) { super(message, options) }
}
