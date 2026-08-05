import { resolveCloudProxyTarget, type CloudProxyTarget } from './cloud-proxy-target'

/**
 * The first round trips of a switch, started before the window that needs them
 * exists.
 *
 * Switching targets reloads the renderer, and nothing remote begins until that
 * reload has finished, React has mounted and `UserProvider` has reached
 * `get-session` — so the reload and the network wait happen one after the other
 * when they could overlap. Main does not have to wait: it is told the new target
 * *before* the reload starts (`applyPreferredApiTarget`) and it already holds
 * the deployment token. So it makes those calls itself, and the proxy answers
 * the renderer from them.
 *
 * The saving is not a cached response — it is the head start. A renderer that
 * arrives mid-flight waits on the *same* request rather than opening a second
 * one, and by then it is most of the way done. It also warms the TLS connection
 * for everything the shell asks for next, since the connection pool belongs to
 * this process and outlives the reload.
 *
 * Deliberately not a cache: each entry answers one request and is then gone. A
 * refetch a second later is a request for fresh data, and this must never be the
 * reason someone sees stale data.
 */

/**
 * What a boot needs before it can show anything: the session the auth gate
 * blocks on, the two settings reads the shell's wizard gate gates on, and the
 * sidebar's agent list. Ordered by who is waiting first.
 *
 * A path only earns a place here if the renderer requests it verbatim — the
 * match is exact, so a query string or a differing path is simply a miss, and a
 * miss costs nothing but the normal request.
 */
const PREFETCH_PATHS = [
  '/api/auth/get-session',
  '/api/user-settings',
  '/api/settings',
  '/api/agents',
  // Not blocking, but chained: the sidebar's Explore item waits on skillsets and
  // then on the agents they make discoverable, so it lands two round trips after
  // everything around it and pushes the nav down when it arrives.
  '/api/skillsets',
  '/api/agents/discoverable-agents',
] as const

/**
 * How long a prefetched response may still answer a request.
 *
 * Long enough to cover a reload (including a cold dev reload), short enough that
 * nothing here can outlive the switch that started it. An entry that expires is
 * just a miss.
 */
const PREFETCH_TTL_MS = 15_000

/** Bodies above this are not worth holding in memory for a head start. */
const MAX_PREFETCH_BODY_BYTES = 2 * 1024 * 1024

/**
 * Requests carrying this header never claim a prefetch entry. The entries are
 * one-shot and exist to give the *reloading renderer* its head start — but
 * main's own background pollers (the tray, the app menu) request the same
 * paths through the same proxy at switch time, and whichever asked first would
 * otherwise consume them.
 */
export const SKIP_BOOT_PREFETCH_HEADER = 'x-skip-boot-prefetch'

export interface PrefetchedResponse {
  status: number
  headers: [string, string][]
  body: ArrayBuffer
}

interface PrefetchEntry {
  /** Which deployment, and on whose authority — both must still hold at use. */
  deploymentUrl: string
  token: string
  startedAt: number
  result: Promise<PrefetchedResponse | null>
  /** Drops this entry once it is too old to be given to anyone. */
  expiry: NodeJS.Timeout
}

const entries = new Map<string, PrefetchEntry>()

/**
 * Drop entries, cancelling their expiry timers.
 *
 * Entries have to be able to leave on their own, not only when someone comes to
 * collect them. A boot that goes somewhere the prefetch did not predict — a
 * login screen, a workspace that has to reconnect — claims none of them, and
 * without this they would sit in memory for the life of the process holding
 * responses fetched under a credential that has since been replaced.
 */
function forget(keys: Iterable<string>): void {
  for (const key of [...keys]) {
    const entry = entries.get(key)
    if (!entry) continue
    clearTimeout(entry.expiry)
    entries.delete(key)
  }
}

/**
 * Begin the boot round trips for the workspace this app is about to drive.
 *
 * Safe to call when there is no workspace or no token: it clears whatever was
 * pending and does nothing else. Never throws and never rejects — a prefetch
 * that fails must degrade to the request the renderer would have made anyway.
 */
export function startCloudBootPrefetch(): void {
  forget(entries.keys())

  // Guarded because of where this is called from: one caller is app startup,
  // ahead of the window being created. Reading the workspace record touches
  // settings on disk, and a head start is never worth a boot.
  let target: CloudProxyTarget | null = null
  try {
    target = resolveCloudProxyTarget()
  } catch {
    return
  }
  if (!target) return

  const startedAt = Date.now()
  for (const path of PREFETCH_PATHS) {
    const expiry = setTimeout(() => forget([path]), PREFETCH_TTL_MS)
    // Never a reason to keep the process alive.
    expiry.unref?.()
    entries.set(path, {
      deploymentUrl: target.deploymentUrl,
      token: target.token,
      startedAt,
      result: prefetch(target, path),
      expiry,
    })
  }
}

async function prefetch(
  target: CloudProxyTarget,
  path: string,
): Promise<PrefetchedResponse | null> {
  try {
    const response = await fetch(`${target.deploymentUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${target.token}` },
      redirect: 'follow',
      // Bounded by the same clock that decides this is too old to hand out.
      // A renderer that claims an entry *awaits* the flight rather than opening
      // its own, so an unbounded one would not merely be wasted — it would hold
      // the request it was meant to accelerate for as long as it hung. Aborting
      // resolves it to null, and the proxy makes the call it always would have.
      signal: AbortSignal.timeout(PREFETCH_TTL_MS),
    })

    // Only a plain success is worth replaying. A 401 here means the token needs
    // the refresh-and-retry the proxy does on the real request, and handing the
    // renderer this copy instead would skip it; anything else is a condition the
    // renderer should meet first-hand rather than through a recording.
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined)
      return null
    }

    const body = await response.arrayBuffer()
    if (body.byteLength > MAX_PREFETCH_BODY_BYTES) return null
    return { status: response.status, headers: [...response.headers], body }
  } catch {
    return null
  }
}

/**
 * Claim the pending or completed prefetch for this request, if it is still the
 * right answer to give.
 *
 * Returns a promise the caller awaits — a renderer that gets here first waits on
 * the flight already in progress, which is the point. Null means "no head start,
 * make the request", which is always safe.
 *
 * The entry is consumed whether or not it is usable: a mismatched token or an
 * expired start means the recording is worthless, and leaving it behind would
 * only let it be reconsidered later when it is staler still.
 */
export function takeCloudBootPrefetch(
  pathAndQuery: string,
  target: CloudProxyTarget,
): Promise<PrefetchedResponse | null> | null {
  const entry = entries.get(pathAndQuery)
  if (!entry) return null
  forget([pathAndQuery])

  // A token refresh (or a different workspace) invalidates everything started
  // under the old one. Comparing here rather than clearing from the refresh path
  // keeps this module a leaf: nothing else has to remember it exists.
  if (entry.deploymentUrl !== target.deploymentUrl || entry.token !== target.token) return null
  if (Date.now() - entry.startedAt > PREFETCH_TTL_MS) return null
  return entry.result
}

/** Test seam: forgets every pending entry. */
export function _resetCloudBootPrefetchForTest(): void {
  forget(entries.keys())
}

/** Test seam: how many responses are still being held. Should return to zero. */
export function _heldCloudBootPrefetchCountForTest(): number {
  return entries.size
}
