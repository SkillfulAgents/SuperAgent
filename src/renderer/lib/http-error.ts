/** An unsuccessful HTTP response, including the server's explanation when available. */
export class HttpError extends Error {
  constructor(public readonly status: number, message = `HTTP ${status}`) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Retrying the same request can recover from transport failures, timeouts, rate limits, and server failures. */
export function isRetryableRequestError(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status === 408 || error.status === 429 || error.status >= 500
}
