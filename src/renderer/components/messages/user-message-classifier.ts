export type UserMessageKind = 'system' | 'interrupt' | 'compact' | 'plain'

interface UserMessageKindSpec {
  kind: Exclude<UserMessageKind, 'plain'>
  /** Cheap check on the raw text. Prefix checks before regexes. */
  match: (text: string) => boolean
  hidden: boolean
}

// Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts
export const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

const USER_MESSAGE_KINDS: readonly UserMessageKindSpec[] = [
  { kind: 'system', match: (t) => t.startsWith(SYSTEM_MESSAGE_PREFIX), hidden: true },
  { kind: 'interrupt', match: (t) => t.startsWith('[Request interrupted by user'), hidden: false },
  { kind: 'compact', match: (t) => /^\/compact(?:\s|$)/.test(t.trim()), hidden: false },
]

const PLAIN = { kind: 'plain', hidden: false } as const

export function classifyUserText(text: string): { kind: UserMessageKind; hidden: boolean } {
  const match = USER_MESSAGE_KINDS.find((spec) => spec.match(text))
  return match ? { kind: match.kind, hidden: match.hidden } : PLAIN
}

export function classifyUserMessage(m: {
  type: string
  content?: { text?: string } | string | null
}): { kind: UserMessageKind; hidden: boolean } {
  if (m.type !== 'user' || typeof m.content !== 'object' || !m.content) return PLAIN
  return classifyUserText(m.content.text ?? '')
}
