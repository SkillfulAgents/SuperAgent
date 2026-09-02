import { isElectron } from './env'
import {
  workspaceUnavailableBodySchema,
  workspaceUnavailableStateSchema,
  type WorkspaceUnavailableState,
} from './workspace-unavailable-schema'

// Set by the ingress on its 502/503 JSON; value is the route state ("waking",
// "sleeping", "error") or "unreachable" for a dead upstream behind a ready route.
export const WORKSPACE_UNAVAILABLE_HEADER = 'x-workspace-unavailable'

const RELOAD_KEY = 'superagent.workspace-unavailable-reload'
const COOLDOWN_MS = 15_000

// sleeping/error mean click-to-wake: reloading would silently drop any typed
// but unsent state, so those surface a prompt instead of a forced reload.
const PROMPT_STATES = new Set<WorkspaceUnavailableState>(['sleeping', 'error'])

let reloadPending = false
let asleep = false
const listeners = new Set<() => void>()
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let reloadImpl = (): void => {
  window.location.reload()
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function isWorkspaceUnavailableError(message: string | null | undefined): boolean {
  return message === 'deployment_unavailable'
}

export function isWorkspaceUnavailableReloadPending(): boolean {
  return reloadPending
}

export function isWorkspaceAsleep(): boolean {
  return asleep
}

// One store for both flags; snapshots above are the useSyncExternalStore reads.
export function subscribeWorkspaceUnavailable(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function _resetWorkspaceUnavailableForTest(): void {
  reloadPending = false
  asleep = false
  listeners.clear()
  if (reloadTimer != null) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  reloadImpl = () => {
    window.location.reload()
  }
  try {
    sessionStorage.removeItem(RELOAD_KEY)
  } catch {
    // jsdom without storage; nothing to clear.
  }
}

export function _setWorkspaceUnavailableReloadForTest(fn: () => void): void {
  reloadImpl = fn
}

export function _armWorkspaceUnavailableReloadForTest(): void {
  reloadPending = true
}

export function _markWorkspaceAsleepForTest(): void {
  markWorkspaceAsleep()
}

function markWorkspaceAsleep(): void {
  if (asleep) return
  asleep = true
  notify()
}

function clearWorkspaceAsleep(): void {
  if (!asleep) return
  asleep = false
  notify()
}

// Some privacy modes throw on any sessionStorage access; a broken cooldown
// must degrade to "reload anyway", never to an exception out of apiFetch.
function lastReloadAt(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  } catch {
    return 0
  }
}

function rememberReloadAt(now: number): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    // Cooldown persistence is best-effort.
  }
}

function armReloadPending(): void {
  if (reloadPending) return
  reloadPending = true
  notify()
}

function reloadForWorkspaceUnavailable(): void {
  // Cover first so in-app 502/503 errors never paint over the last surface.
  armReloadPending()
  const last = lastReloadAt()
  const now = Date.now()
  if (Number.isFinite(last) && now - last < COOLDOWN_MS) {
    if (reloadTimer == null) {
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        rememberReloadAt(Date.now())
        reloadImpl()
      }, COOLDOWN_MS - (now - last))
    }
    return
  }
  rememberReloadAt(now)
  reloadImpl()
}

async function unavailableStateOf(response: Response): Promise<WorkspaceUnavailableState | null> {
  const header = response.headers.get(WORKSPACE_UNAVAILABLE_HEADER)
  if (header) {
    const parsed = workspaceUnavailableStateSchema.safeParse(header)
    return parsed.success ? parsed.data : null
  }
  // Legacy 502 text also covered app-generated 502s, so only 503 has a safe fallback.
  if (response.status !== 503) return null
  if (typeof response.clone !== 'function') return null
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return null
  }
  const parsed = workspaceUnavailableBodySchema.safeParse(body)
  if (!parsed.success) return null
  return parsed.data.state
}

// Open-tab 502/503 from ingress. Mid-boot states reload so the next document
// request gets the waiting page; sleeping/error only flag a wake prompt.
export async function maybeReloadForWorkspaceUnavailable(response: Response): Promise<void> {
  // The workspace can wake through another path (another tab, ingress timer);
  // any success drops the prompt instead of forcing a pointless reload.
  if (response.ok) {
    clearWorkspaceAsleep()
    return
  }
  if (response.status !== 502 && response.status !== 503) return
  // An Electron renderer loads local assets, so a reload never reaches the
  // ingress waiting page — WorkspaceReconnect handles this case instead.
  if (isElectron()) return
  const state = await unavailableStateOf(response)
  if (!state) return
  if (PROMPT_STATES.has(state)) {
    markWorkspaceAsleep()
    return
  }
  reloadForWorkspaceUnavailable()
}
