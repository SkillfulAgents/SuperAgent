import { isElectron } from './env'
import { workspaceUnavailableBodySchema } from './workspace-unavailable-schema'

// Set by the ingress on its 502/503 JSON; value is the route state ("waking",
// "sleeping", "error") or "unreachable" for a dead upstream behind a ready route.
export const WORKSPACE_UNAVAILABLE_HEADER = 'x-workspace-unavailable'

const RELOAD_KEY = 'superagent.workspace-unavailable-reload'
const COOLDOWN_MS = 15_000

// sleeping/error mean click-to-wake: reloading would silently drop any typed
// but unsent state, so those surface a prompt instead of a forced reload.
const PROMPT_STATES = new Set(['sleeping', 'error'])

let reloadPending = false
let asleep = false
const asleepListeners = new Set<() => void>()
let reloadImpl = (): void => {
  window.location.reload()
}

export function isWorkspaceUnavailableError(message: string | null | undefined): boolean {
  if (!message) return false
  return workspaceUnavailableBodySchema.safeParse({ error: message }).success
}

export function isWorkspaceUnavailableReloadPending(): boolean {
  return reloadPending
}

export function isWorkspaceAsleep(): boolean {
  return asleep
}

export function subscribeWorkspaceAsleep(listener: () => void): () => void {
  asleepListeners.add(listener)
  return () => {
    asleepListeners.delete(listener)
  }
}

export function _resetWorkspaceUnavailableForTest(): void {
  reloadPending = false
  asleep = false
  asleepListeners.clear()
  reloadImpl = () => {
    window.location.reload()
  }
  sessionStorage.removeItem(RELOAD_KEY)
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
  for (const listener of asleepListeners) listener()
}

function reloadForWorkspaceUnavailable(): void {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  reloadPending = true
  reloadImpl()
}

async function unavailableStateOf(response: Response): Promise<string | null> {
  const header = response.headers.get(WORKSPACE_UNAVAILABLE_HEADER)
  if (header) return header
  // Fallback for ingress deployments that predate the header.
  if (typeof response.clone !== 'function') return null
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return null
  }
  const parsed = workspaceUnavailableBodySchema.safeParse(body)
  if (!parsed.success) return null
  return parsed.data.state ?? 'unreachable'
}

// Open-tab 502/503 from ingress. Mid-boot states reload so the next document
// request gets the waiting page; sleeping/error only flag a wake prompt.
export async function maybeReloadForWorkspaceUnavailable(response: Response): Promise<void> {
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
