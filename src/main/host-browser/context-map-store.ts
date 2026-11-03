/**
 * Persistent instanceId → Browserbase contextId map shared by the Browserbase
 * and platform host-browser providers, kept as a host file.
 *
 * Hardened: the map is read-modify-written from concurrent
 * `getOrCreateContext` calls (which `await` a network create between read and
 * write). The old code read with a swallow-to-`{}` catch and wrote
 * non-atomically, so a transient bad read or two instances racing wiped every
 * other agent's persistent context — and leaked the now-orphaned (billable)
 * Browserbase contexts. This store reads fail-closed and adds an entry in one
 * read-modify-write that keeps a mapping stored first.
 */
import { z } from 'zod'
import { parseJsonStrict } from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import { hostState } from '@shared/lib/host-state/backend'

const contextMapSchema = z.record(z.string(), z.string())

export type ContextMap = Record<string, string>

function parseContextMap(file: string, raw: string | null): ContextMap {
  return raw === null ? {} : parseJsonStrict(file, raw, contextMapSchema)
}

/**
 * Read the map. Fail-closed: absent file → `{}`, but a corrupt/torn file or IO
 * error THROWS (so a transiently-unreadable file can't be silently treated as
 * empty and then overwritten, wiping/leaking every other agent's context).
 */
export function loadContextMap(file: string): ContextMap {
  return parseContextMap(file, hostState().read(file))
}

// In-flight context creations, keyed by `${file}::${key}`. Dedups concurrent
// first-opens for the SAME key within this process (P2): without this, two
// concurrent calls that both miss the map would each create a paid remote
// context and the second would orphan/leak the first. Different keys are NOT
// serialized — they create in parallel. Two processes may still both create
// one; the first stored wins and the other is reported as orphaned.
const inflightContextCreations = new Map<string, Promise<string>>()

/**
 * Return the existing `key → contextId` mapping in the host file `file`, or
 * create one exactly once. `create` performs the (paid, network)
 * remote-context creation and returns its id; it is invoked at most once per
 * key even under concurrent callers, and the result is saved before returning.
 */
export async function getOrCreateMapping(
  file: string,
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  const existing = loadContextMap(file)[key]
  if (existing) return existing

  const inflightKey = `${file}::${key}`
  const pending = inflightContextCreations.get(inflightKey)
  if (pending) return pending

  const p = (async () => {
    // Re-check inside the in-flight guard: a create for this key may have landed
    // (and been persisted) between the read above and us claiming the slot.
    const fresh = loadContextMap(file)[key]
    if (fresh) return fresh
    const contextId = await create()
    let stored: string
    try {
      hostState().write(file, (raw) => {
        const map = parseContextMap(file, raw)
        map[key] ??= contextId
        return JSON.stringify(map, null, 2)
      })
      await hostState().flush()
      stored = loadContextMap(file)[key] ?? contextId
    } catch (err) {
      // The remote context was created and BILLED, but persisting it failed
      // (corrupt map file, disk full, …). Surface the orphaned id so it can be
      // reclaimed/deleted out-of-band instead of silently leaking — and so a
      // recurring persist failure (which would re-create a paid context on every
      // launch) is visible — then rethrow.
      captureException(err, {
        tags: { area: 'host-browser-context-map', op: 'persist' },
        extra: { file, key, orphanedContextId: contextId },
      })
      throw err
    }
    if (stored !== contextId) {
      captureException(new Error('Another process stored a context for this key first'), {
        tags: { area: 'host-browser-context-map', op: 'persist' },
        extra: { file, key, orphanedContextId: contextId },
      })
    }
    return stored
  })()
  inflightContextCreations.set(inflightKey, p)
  try {
    return await p
  } finally {
    inflightContextCreations.delete(inflightKey)
  }
}
