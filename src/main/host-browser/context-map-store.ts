/**
 * Persistent key → Browserbase contextId mappings shared by the Browserbase
 * and platform host-browser providers, one app record per key
 * (`browser-context:<provider>:<key>`; imported from the old
 * `browserbase-contexts.json` / `platform-browserbase-contexts.json` files by
 * data migration 9).
 *
 * A mapping is written with insert-if-absent, so creating one key's mapping
 * never touches another's, and a stored id that cannot be read throws instead
 * of being treated as absent (which would create, and bill, a new context).
 */
import type { AppRecordStore } from '@shared/lib/app-records/record-store'
import { appRecordStore, readRecord, serializeRecordValue } from '@shared/lib/app-records/records'
import {
  browserContextIdRecordSchema,
  browserContextKey,
  type BrowserContextProvider,
} from '@shared/lib/app-records/record-schemas'
import { captureException } from '@shared/lib/error-reporting'

export type { BrowserContextProvider }

/** The stored context id for `key`, or null. Throws on a database error or an invalid stored value. */
export async function readContextMapping(
  provider: BrowserContextProvider,
  key: string,
  store: AppRecordStore = appRecordStore(),
): Promise<string | null> {
  return (await readRecord(store, browserContextKey(provider, key), browserContextIdRecordSchema))?.value ?? null
}

// In-flight context creations, keyed by `${provider}::${key}`. Dedups
// concurrent first-opens for the SAME key within this process: without it,
// two concurrent calls that both miss would each create a paid remote context
// and one would be orphaned. Different keys are NOT serialized. Across
// processes, insert-if-absent picks one winner and the loser reports its
// orphaned context (below).
const inflightContextCreations = new Map<string, Promise<string>>()

/**
 * Return the existing `key → contextId` mapping, or create one. `create`
 * performs the (paid, network) remote-context creation and returns its id; it
 * runs at most once per key per process even under concurrent callers, and
 * its result is committed before this returns. When another process committed
 * a mapping first, that mapping is returned and the context created here is
 * reported as orphaned.
 */
export async function getOrCreateMapping(
  provider: BrowserContextProvider,
  key: string,
  create: () => Promise<string>,
  store: AppRecordStore = appRecordStore(),
): Promise<string> {
  const existing = await readContextMapping(provider, key, store)
  if (existing) return existing

  const inflightKey = `${provider}::${key}`
  const pending = inflightContextCreations.get(inflightKey)
  if (pending) return pending

  const p = (async () => {
    // Re-check inside the in-flight guard: a create for this key may have landed
    // between the read above and us claiming the slot.
    const fresh = await readContextMapping(provider, key, store)
    if (fresh) return fresh
    const contextId = await create()
    const recordKey = browserContextKey(provider, key)
    let committed: string | null
    try {
      await store.insertIfAbsent(recordKey, serializeRecordValue(recordKey, contextId, browserContextIdRecordSchema))
      committed = await readContextMapping(provider, key, store)
    } catch (err) {
      // The remote context was created and BILLED, but persisting it failed.
      // Surface the orphaned id so it can be reclaimed out-of-band instead of
      // silently leaking, then rethrow.
      captureException(err, {
        tags: { area: 'host-browser-context-map', op: 'persist' },
        extra: { provider, key, orphanedContextId: contextId },
      })
      throw err
    }
    if (!committed) throw new Error(`Browser context mapping ${recordKey} disappeared after it was written`)
    if (committed !== contextId) {
      // Another process committed a mapping for this key first; use it.
      captureException(new Error('Browserbase context orphaned by a concurrent first open'), {
        level: 'warning',
        tags: { area: 'host-browser-context-map', op: 'race' },
        extra: { provider, key, orphanedContextId: contextId },
      })
    }
    return committed
  })()
  inflightContextCreations.set(inflightKey, p)
  try {
    return await p
  } finally {
    inflightContextCreations.delete(inflightKey)
  }
}
