import { isElectron } from './env'
import { workspaceUnavailableBodySchema } from './workspace-unavailable-schema'

const RELOAD_KEY = 'superagent.workspace-unavailable-reload'
const COOLDOWN_MS = 15_000

let reloadPending = false
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

export function _resetWorkspaceUnavailableForTest(): void {
  reloadPending = false
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

function reloadForWorkspaceUnavailable(): void {
  if (isElectron()) return
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  reloadPending = true
  reloadImpl()
}

// Open-tab 502/503 from ingress: reload so the next document request gets the waiting page.
export async function maybeReloadForWorkspaceUnavailable(response: Response): Promise<void> {
  if (response.status !== 502 && response.status !== 503) return
  if (typeof response.clone !== 'function') return
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return
  }
  if (!workspaceUnavailableBodySchema.safeParse(body).success) return
  reloadForWorkspaceUnavailable()
}
