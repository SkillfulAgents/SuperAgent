// Read-only chat mirror: connectors prefix an incoming message with an escaped
// "\[sender]: " (e.g. Telegram/Slack) so the agent can attribute who spoke. The
// mirror lifts that prefix into the sender label instead of showing it inline.
// Live sessions never carry it.
const SENDER_PREFIX = /^\\?\[([^\]]+)\]:\s*/

/**
 * Split a leading "[sender]: " prefix (optionally backslash-escaped) off message
 * text. Returns the sender (null when there's no prefix) and the text with the
 * prefix removed. Only a prefix at the very start counts - a bracketed span mid
 * text is left untouched.
 */
export function parseSenderPrefix(text: string): { sender: string | null; cleanText: string } {
  const match = text.match(SENDER_PREFIX)
  if (!match) return { sender: null, cleanText: text }
  return { sender: match[1], cleanText: text.slice(match[0].length) }
}
