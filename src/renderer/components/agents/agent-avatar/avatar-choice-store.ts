import { useSyncExternalStore } from 'react'
import { z } from 'zod'

import { getActiveTarget } from '@renderer/lib/api-target'

import { avatarForId, type AvatarId } from './avatar-ids'

/**
 * Avatars people picked for their agents, remembered on this device (per API
 * target). Prototype storage: a choice doesn't follow the agent to another
 * machine or teammate. Stored as avatar ids (colourway and shape by name), so
 * reordering the catalogues can't swap anyone's avatar.
 */

const choicesSchema = z.record(z.string(), z.string())
type Choices = z.infer<typeof choicesSchema>

const listeners = new Set<() => void>()
// Parsed choices, keyed by the raw stored string so a change made elsewhere
// (another window, a cleared store) is picked up on the next read.
let cache: { key: string; raw: string | null; choices: Choices } | null = null

function storageKey(): string {
  let target = 'default'
  try {
    target = getActiveTarget()
  } catch {
    // Target not resolved yet (or in tests): fall back to an unscoped key.
  }
  return `agent-avatar-choices.${target}`
}

function readStored(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key)
  } catch {
    return undefined // Storage blocked.
  }
}

function readChoices(): Choices {
  const key = storageKey()
  const raw = readStored(key)
  // Blocked storage: whatever this session has picked so far.
  if (raw === undefined) return cache?.key === key ? cache.choices : {}
  if (cache?.key === key && cache.raw === raw) return cache.choices
  let choices: Choices = {}
  try {
    const parsed = choicesSchema.safeParse(JSON.parse(raw ?? '{}'))
    if (parsed.success) choices = parsed.data
  } catch {
    // Unreadable: no choices.
  }
  cache = { key, raw, choices }
  return choices
}

function notify() {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Another window picked an avatar.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey()) return
    cache = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The avatar id picked for this agent, or null when it wears its own (see agentAvatarId). */
export function useAvatarChoice(slug: string): AvatarId | null {
  const id = useSyncExternalStore(subscribe, () => readChoices()[slug] ?? null)
  return id !== null && avatarForId(id) ? id : null
}

/** Pick an avatar for an agent; null returns it to its own. */
export function setAvatarChoice(slug: string, id: AvatarId | null) {
  const next = { ...readChoices() }
  if (id === null) delete next[slug]
  else next[slug] = id
  const key = storageKey()
  const serialized = JSON.stringify(choicesSchema.parse(next))
  try {
    localStorage.setItem(key, serialized)
    cache = { key, raw: serialized, choices: next }
  } catch {
    // Storage blocked or full: the choice still applies until reload.
    cache = { key, raw: readStored(key) ?? null, choices: next }
  }
  notify()
}
