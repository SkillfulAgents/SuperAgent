/**
 * Persistent instanceId → Browserbase contextId map shared by the Browserbase
 * and platform host-browser providers.
 *
 * Hardened: the map is a single JSON file read-modify-written from
 * concurrent `getOrCreateContext` calls (which `await` a network create between
 * read and write). The old code read with a swallow-to-`{}` catch and wrote
 * non-atomically, so a transient bad read or two instances racing wiped every
 * other agent's persistent context — and leaked the now-orphaned (billable)
 * Browserbase contexts. This store reads fail-closed, writes atomically, and
 * serializes the upsert under a per-file lock.
 */
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import {
  readJsonFileStrictSync,
  writeJsonFileAtomicSync,
  withFileLock,
} from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import { currentStore, hostStateActive } from '@shared/lib/host-state/scope'

const contextMapSchema = z.record(z.string(), z.string())

export type ContextMap = Record<string, string>

/**
 * Read the map. Fail-closed: absent file → `{}`, but a corrupt/torn file or IO
 * error THROWS (so a transiently-unreadable file can't be silently treated as
 * empty and then overwritten, wiping/leaking every other agent's context).
 */
export function loadContextMap(filePath: string): ContextMap {
  return readJsonFileStrictSync(filePath, contextMapSchema, {})
}

/** Atomic (temp-file + rename) overwrite of the whole map. */
export function saveContextMap(filePath: string, map: ContextMap): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJsonFileAtomicSync(filePath, map)
}

/**
 * Serialized + atomic upsert of a single `key → contextId` mapping. Re-reads
 * the map fresh under the lock (so a mapping created concurrently for a
 * different key survives) and writes atomically.
 */
export async function setContextMapping(filePath: string, key: string, contextId: string): Promise<void> {
  await withFileLock(filePath, async () => {
    const map = loadContextMap(filePath)
    map[key] = contextId
    saveContextMap(filePath, map)
  })
}

// In-flight context creations, keyed by `${resolved file}::${key}`. Dedups
// concurrent first-opens for the SAME key within this process (P2): the
// file lock only protects the WRITE, so without this, two concurrent calls that
// both miss the map would each create a paid remote context and the second
// would orphan/leak the first. Different keys are NOT serialized — they create
// in parallel. (Residual: a multi-process/replica race could still double-create
// across processes; acceptable for the host-browser providers.)
const inflightContextCreations = new Map<string, Promise<string>>()

/**
 * Return the existing `key → contextId` mapping, or create one exactly once.
 * `create` performs the (paid, network) remote-context creation and returns its
 * id; it is invoked at most once per key even under concurrent callers, and the
 * result is persisted via {@link setContextMapping} before returning.
 */
export async function getOrCreateMapping(
  filePath: string,
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  if (hostStateActive()) return getOrCreateSharedMapping(path.basename(filePath), key, create)
  const existing = loadContextMap(filePath)[key]
  if (existing) return existing

  const inflightKey = `${path.resolve(filePath)}::${key}`
  const pending = inflightContextCreations.get(inflightKey)
  if (pending) return pending

  const p = (async () => {
    // Re-check inside the in-flight guard: a create for this key may have landed
    // (and been persisted) between the read above and us claiming the slot.
    const fresh = loadContextMap(filePath)[key]
    if (fresh) return fresh
    const contextId = await create()
    try {
      await setContextMapping(filePath, key, contextId)
    } catch (err) {
      // The remote context was created and BILLED, but persisting it failed
      // (corrupt map file, disk full, …). Surface the orphaned id so it can be
      // reclaimed/deleted out-of-band instead of silently leaking — and so a
      // recurring persist failure (which would re-create a paid context on every
      // launch) is visible — then rethrow.
      captureException(err, {
        tags: { area: 'host-browser-context-map', op: 'persist' },
        extra: { filePath, key, orphanedContextId: contextId },
      })
      throw err
    }
    return contextId
  })()
  inflightContextCreations.set(inflightKey, p)
  try {
    return await p
  } finally {
    inflightContextCreations.delete(inflightKey)
  }
}

/**
 * The same mapping in the shared host state, for a host that serves requests
 * on many isolates: the file would be empty on the next request, so every
 * launch would create (and bill) a new context and lose the agent's sign-ins.
 * Two isolates may still both create one; the first stored wins and the other
 * is reported as orphaned, as a failed persist is.
 */
async function getOrCreateSharedMapping(file: string, key: string, create: () => Promise<string>): Promise<string> {
  const store = currentStore()
  const storeKey = `browser-context:${file}:${key}`
  const existing = await store.get(storeKey)
  if (existing) return existing.value

  const inflightKey = `${storeKey}::shared`
  const pending = inflightContextCreations.get(inflightKey)
  if (pending) return pending

  const p = (async () => {
    const contextId = await create()
    const stored = await store.insertIfAbsent(storeKey, contextId)
    if (stored.value !== contextId) {
      captureException(new Error('Another process stored a context for this key first'), {
        tags: { area: 'host-browser-context-map', op: 'persist' },
        extra: { key, orphanedContextId: contextId },
      })
    }
    return stored.value
  })()
  inflightContextCreations.set(inflightKey, p)
  try {
    return await p
  } finally {
    inflightContextCreations.delete(inflightKey)
  }
}
