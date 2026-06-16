/**
 * Telegram Bot API 10.1 Rich Messages — markdown passthrough converter.
 *
 * Rich Markdown is "compatible with GitHub Flavored Markdown where possible",
 * so we hand the agent's markdown straight to Telegram. Telegram parses it into
 * rich blocks server-side; we do NOT build RichBlock objects.
 */
import { splitChatMessage } from './utils'
import type { InputRichMessage } from './telegram-rich-message-schema'

/** Max UTF-8 chars in a rich message (Bot API 10.1). */
export const RICH_MAX_LENGTH = 32768

export interface RichMessageOptions {
  skipEntityDetection?: boolean
}

/** Wrap agent markdown as an InputRichMessage. Near-identity passthrough. */
export function markdownToRichMessage(md: string, opts: RichMessageOptions = {}): InputRichMessage {
  return {
    markdown: md,
    ...(opts.skipEntityDetection ? { skip_entity_detection: true } : {}),
  }
}

/** Split an over-long body on block/paragraph boundaries under the rich ceiling. */
export function splitForRichLimits(md: string): string[] {
  return splitChatMessage(md, RICH_MAX_LENGTH)
}

/** Telegram's plain (parse_mode) message text limit — the legacy HTML sink. */
export const HTML_MAX_LENGTH = 4096

/** Split for the legacy HTML sink, which the rich path falls back to on error. */
export function splitForHtmlLimits(md: string): string[] {
  return splitChatMessage(md, HTML_MAX_LENGTH)
}

/**
 * "Thinking…" indicator frames shown before the response streams. The indicator is
 * a real message posted via sendRichMessage; each frame is applied by editing that
 * message in place (editMessageText), so the label stays static and only the dots
 * animate. The message is deleted (clearThinking) when the response takes over.
 * A draft is deliberately NOT used: a draft renders by typing its text out letter
 * by letter, which would animate the whole word instead of just the dots.
 */
export const THINKING_FRAMES: InputRichMessage[] = [
  { markdown: '✨ Thinking' },
  { markdown: '✨ Thinking.' },
  { markdown: '✨ Thinking..' },
  { markdown: '✨ Thinking...' },
]
