/** A volume failure that can be shown to the caller without exposing upstream details. */
export class VolumeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 429 | 503, readonly retryAfter?: number) {
    super(message)
    this.name = 'VolumeError'
  }
}

export class VolumePreparingError extends VolumeError {
  constructor(readonly reason?: string) { super(reason ? `preparing: ${reason}` : 'preparing', 503) }
}
