export interface Mention {
  userId: string
  name: string
}

// Only an unescaped marker counts. prosemirror-markdown escapes `[` in plain text,
// so a hand-typed `[[mention:` arrives as `\[\[mention:` and never matches.
export const MENTION_RE = /(?<!\\)\[\[mention:([A-Za-z0-9_-]{1,64})\|([^\]|]+)\]\]/g
const CONTEXT_BODY = 'tagged a teammate in this chat to bring it to their attention. This is an FYI, not a request to you. Do not act on it.'
// Terminate on the fixed FYI sentence so a `]` in the sender name cannot
// leave the context line stuck on the bubble.
const CONTEXT_RE = new RegExp(
  String.raw`\n\n\[\[mention-context:.*? ${CONTEXT_BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\]\]\s*$`,
)

export function formatMention(m: Mention): string {
  return `[[mention:${m.userId}|${encodeURIComponent(m.name)}]]`
}

export function decodeMentionName(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

export function parseMentions(text: string): Mention[] {
  return Array.from(text.matchAll(MENTION_RE), (m) => ({ userId: m[1], name: decodeMentionName(m[2]) }))
}

export function mentionContextLine(senderName: string): string {
  return `[[mention-context: ${senderName} ${CONTEXT_BODY}]]`
}

export function appendMentionContext(text: string, senderName: string): string {
  return `${text}\n\n${mentionContextLine(senderName)}`
}

export function stripMentionContext(text: string): string {
  return text.replace(CONTEXT_RE, '')
}

export function flattenMentions(text: string): string {
  return stripMentionContext(text).replace(MENTION_RE, (_m, _id, name) => `@${decodeMentionName(name)}`)
}

export function mentionsToMarkdownLinks(text: string): string {
  return text.replace(MENTION_RE, (_m, id, name) => {
    const label = decodeMentionName(name).replace(/\\/g, '\\\\').replace(/]/g, '\\]')
    return `[@${label}](mention:${id})`
  })
}

/** Rewrite marker display names from the membership roster, keeping the ids. */
export function applyCanonicalMentionNames(text: string, nameById: ReadonlyMap<string, string>): string {
  return text.replace(MENTION_RE, (full, id: string) => {
    const name = nameById.get(id)
    return name ? formatMention({ userId: id, name }) : full
  })
}

export function resolveMentions(
  mentions: Mention[],
  aclUserIds: ReadonlySet<string>,
  senderId: string,
): { ok: true; recipients: Mention[] } | { ok: false; unknown: string[] } {
  const unknown = mentions.filter((m) => !aclUserIds.has(m.userId)).map((m) => m.userId)
  if (unknown.length > 0) return { ok: false, unknown: Array.from(new Set(unknown)) }
  const seen = new Set<string>()
  const recipients: Mention[] = []
  for (const m of mentions) {
    if (m.userId === senderId || seen.has(m.userId)) continue
    seen.add(m.userId)
    recipients.push(m)
  }
  return { ok: true, recipients }
}
