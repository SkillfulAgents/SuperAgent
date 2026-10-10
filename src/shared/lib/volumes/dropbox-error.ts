/** An upstream failure, distinct from a missing or inaccessible filesystem path. */
export class DropboxUnavailableError extends Error {
  constructor(readonly status: 429 | 503 = 503, readonly retryAfter?: number) {
    super(status === 429
      ? 'Dropbox is busy. Please try again shortly.'
      : 'Dropbox is temporarily unavailable. Please try again.')
    this.name = 'DropboxUnavailableError'
  }
}
