import { VolumeError } from './volume-error'

/** An upstream failure, distinct from a missing or inaccessible filesystem path. */
export class DropboxUnavailableError extends VolumeError {
  constructor(status: 429 | 503 = 503, retryAfter?: number) {
    super(status === 429
      ? 'Dropbox is busy. Please try again shortly.'
      : 'Dropbox is temporarily unavailable. Please try again.', status, retryAfter)
    this.name = 'DropboxUnavailableError'
  }
}
