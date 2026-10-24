import { useSyncExternalStore } from 'react'
import type { LoginFillResult } from './login-request'

/**
 * Per-request submission state for sign-in requests, shared by the card and
 * its form (the card swaps the form for its completed row as it settles). A
 * plain store rather than a react-query mutation on purpose: a mutation keeps
 * its variables — here the user's password — in the query cache for minutes.
 * Secrets live only in the form's own state and the request body; the store
 * below recalls the account identifier alone.
 */

export type LoginAction = 'fill' | 'via' | 'manual' | 'decline'

/**
 * Why the server turned a fill down, when the form can do something about it:
 * fields the saved account could not fill now (show them), or a saved
 * account that is gone (ask for every field).
 */
export type LoginRecovery = { reason: 'fields_needed'; fields: number[] } | { reason: 'account_unavailable' }

export class LoginActionError extends Error {
  constructor(message: string, readonly recovery?: LoginRecovery) {
    super(message)
  }
}

export type LoginRequestState =
  | { status: 'idle'; error?: string; recovery?: LoginRecovery }
  | { status: 'submitting'; action: LoginAction }
  | { status: 'filled'; result: LoginFillResult }
  /** The user signs in through another account: `provider` is that account's username. */
  | { status: 'via'; provider: string }
  | { status: 'manual' }
  | { status: 'declined' }
  /** Answered elsewhere (another window, or it ended) before this one acted. */
  | { status: 'settled' }

const IDLE: LoginRequestState = { status: 'idle' }
const states = new Map<string, LoginRequestState>()
const listeners = new Set<() => void>()

export function loginRequestKey(agentSlug: string, sessionId: string, toolUseId: string): string {
  return `${agentSlug}\u0000${sessionId}\u0000${toolUseId}`
}

export function getLoginRequestState(key: string): LoginRequestState {
  return states.get(key) ?? IDLE
}

export function setLoginRequestState(key: string, state: LoginRequestState): void {
  states.set(key, state)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLoginRequestState(key: string): LoginRequestState {
  return useSyncExternalStore(subscribe, () => getLoginRequestState(key), () => IDLE)
}

/**
 * Run one action for a request unless another is already running or done —
 * checked synchronously, so a second click in the same frame cannot send it
 * twice.
 */
export async function runLoginAction<T extends LoginRequestState>(
  key: string,
  action: LoginAction,
  run: () => Promise<T>,
): Promise<T | null> {
  const current = getLoginRequestState(key)
  if (current.status !== 'idle') return null
  setLoginRequestState(key, { status: 'submitting', action })
  try {
    const next = await run()
    setLoginRequestState(key, next)
    return next
  } catch (error) {
    setLoginRequestState(key, {
      status: 'idle',
      error: error instanceof Error ? error.message : 'Request failed',
      ...(error instanceof LoginActionError && error.recovery ? { recovery: error.recovery } : {}),
    })
    return null
  }
}

/**
 * The account identifier the user typed, kept in this window's memory for a
 * few minutes so the agent's retry in the same session (it re-mapped the
 * form, or the password was wrong) does not start blank. Only the
 * identifier: passwords, codes and other fields are never kept past the
 * form. Scoped to the session, dropped on a timer, and forgotten when the
 * signed-in user changes.
 */
const REMEMBER_MS = 10 * 60 * 1000
const remembered = new Map<string, { values: Map<string, string>; timer: ReturnType<typeof setTimeout> }>()

function memoryKey(agentSlug: string, sessionId: string, origin: string): string {
  return `${agentSlug}\u0000${sessionId}\u0000${origin}`
}

function fieldKey(field: { kind: string; label: string }): string {
  return `${field.kind}\u0000${field.label.toLowerCase()}`
}

export function rememberLoginValues(
  agentSlug: string,
  sessionId: string,
  origin: string,
  fields: Array<{ kind: string; label: string }>,
  values: string[],
): void {
  const key = memoryKey(agentSlug, sessionId, origin)
  const entry = new Map<string, string>()
  fields.forEach((field, index) => {
    if (field.kind === 'username' && values[index]) entry.set(fieldKey(field), values[index])
  })
  clearTimeout(remembered.get(key)?.timer)
  if (entry.size === 0) {
    remembered.delete(key)
    return
  }
  const timer = setTimeout(() => remembered.delete(key), REMEMBER_MS)
  remembered.set(key, { values: entry, timer })
}

export function recallLoginValues(
  agentSlug: string,
  sessionId: string,
  origin: string,
  fields: Array<{ kind: string; label: string }>,
): string[] {
  const entry = remembered.get(memoryKey(agentSlug, sessionId, origin))
  return fields.map((field) => (field.kind === 'username' ? entry?.values.get(fieldKey(field)) ?? '' : ''))
}

/** Forget every remembered identifier (the signed-in user changed). */
export function forgetLoginValues(): void {
  for (const { timer } of remembered.values()) clearTimeout(timer)
  remembered.clear()
}

/** Test seam. */
export function resetLoginRequestStore(): void {
  states.clear()
  forgetLoginValues()
}
