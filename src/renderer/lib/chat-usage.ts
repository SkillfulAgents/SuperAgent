/**
 * How often and how recently this browser opened or mentioned each chat, so the
 * `@` picker can put the chats someone actually uses first. Kept per device.
 */
const STORAGE_KEY = 'gamut:chat-usage:v1'
const MAX_ENTRIES = 300
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

interface ChatUse {
  count: number
  last: number
}

function read(): Record<string, ChatUse> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function recordChatUse(sessionId: string, now = Date.now()): void {
  const uses = read()
  const previous = uses[sessionId]
  uses[sessionId] = { count: (previous?.count ?? 0) + 1, last: now }
  const kept = Object.entries(uses).sort(([, a], [, b]) => b.last - a.last).slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage full or blocked: ranking falls back to last activity.
  }
}

/** Each use counts for less as it ages: half as much every week. 0 for a chat never used here. */
export function chatUseScores(now = Date.now()): (sessionId: string) => number {
  const uses = read()
  return (sessionId) => {
    const use = uses[sessionId]
    return use ? use.count * 0.5 ** ((now - use.last) / HALF_LIFE_MS) : 0
  }
}
