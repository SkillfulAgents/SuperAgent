/**
 * Typed access to app records: every value is parsed with its key's Zod
 * schema when it is read and when it is written, and the identities a
 * deployment creates once (tenant id, auth secret, host container tokens)
 * are created with insert-if-absent so concurrent first uses agree.
 *
 * The store is installed once by the entry point, after `openDatabase()` and
 * before anything reads a record (`installAppRecordStore`). It is the
 * deployment's store for the life of the process, never swapped per request.
 */
import type { z } from 'zod'
import type { AppRecordStore, StoredRecord } from './record-store'

let installed: AppRecordStore | null = null

/**
 * Register the deployment's record store. Entry points call this once, right
 * after `openDatabase()`; a second store is refused, so a process never
 * serves records from two places.
 */
export function installAppRecordStore(store: AppRecordStore): void {
  if (installed && installed !== store) {
    throw new Error('An app record store is already installed; a process serves records from one store.')
  }
  installed = store
}

/** The installed store. Throws until the entry point has installed one. */
export function appRecordStore(): AppRecordStore {
  if (!installed) {
    throw new Error(
      'App records are not available yet: the entry point must call installAppRecordStore() after openDatabase(), before anything reads settings or host records.',
    )
  }
  return installed
}

export function isAppRecordStoreInstalled(): boolean {
  return installed !== null
}

/** Forget the installed store. For tests and for a process that closes its database. */
export function uninstallAppRecordStore(): void {
  installed = null
}

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

/** Parse a stored value with its schema; throws InvalidAppRecordError. */
export function parseRecordValue<S extends z.ZodType>(key: string, stored: string, schema: S): z.output<S> {
  let json: unknown
  try {
    json = JSON.parse(stored)
  } catch (cause) {
    throw new InvalidAppRecordError(key, 'not JSON', { cause })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new InvalidAppRecordError(key, parsed.error.message, { cause: parsed.error })
  return parsed.data
}

/** Validate a value against its schema and serialize it for storage. */
export function serializeRecordValue<S extends z.ZodType>(key: string, value: z.input<S>, schema: S): string {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidAppRecordError(key, `refusing to write: ${parsed.error.message}`, { cause: parsed.error })
  }
  const json = JSON.stringify(parsed.data)
  if (json === undefined) throw new InvalidAppRecordError(key, 'refusing to write a value with no JSON form')
  return json
}

export interface ReadRecord<T> {
  readonly value: T
  readonly revision: number
}

/** Read and parse a record; null when absent. A database error or an invalid value throws. */
export async function readRecord<S extends z.ZodType>(
  store: AppRecordStore,
  key: string,
  schema: S,
): Promise<ReadRecord<z.output<S>> | null> {
  const stored: StoredRecord | null = await store.read(key)
  if (!stored) return null
  return { value: parseRecordValue(key, stored.value, schema), revision: stored.revision }
}

/**
 * The record's value, created by `create` when the key is absent. Concurrent
 * first uses converge: each inserts only if absent and then returns what the
 * database holds, so a caller whose insert lost returns the winner's value,
 * never its own discarded candidate. A database error or an invalid stored
 * value throws: neither is evidence that the record is absent.
 */
export async function getOrCreateRecord<S extends z.ZodType>(
  store: AppRecordStore,
  key: string,
  schema: S,
  create: () => z.input<S>,
): Promise<z.output<S>> {
  const existing = await readRecord(store, key, schema)
  if (existing) return existing.value
  await store.insertIfAbsent(key, serializeRecordValue(key, create(), schema))
  const committed = await readRecord(store, key, schema)
  if (!committed) throw new Error(`App record "${key}" was created and then disappeared before it could be read back`)
  return committed.value
}
