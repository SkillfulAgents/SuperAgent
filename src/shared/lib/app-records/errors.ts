/**
 * The app records' error, in a module that imports nothing: settings extends
 * it at load time, and records.ts imports the database, whose boot graph
 * reaches settings again.
 */

/** A stored value that is not valid JSON or does not match its key's schema. Never a reason to replace it. */
export class InvalidAppRecordError extends Error {
  constructor(
    readonly key: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`App record "${key}" is invalid: ${message}`, options)
    this.name = 'InvalidAppRecordError'
  }
}
