/**
 * Telegram Bot API 10.1 Rich Messages — markdown passthrough converter.
 *
 * Rich Markdown is "compatible with GitHub Flavored Markdown where possible",
 * so we hand the agent's markdown straight to Telegram. Telegram parses it into
 * rich blocks server-side; we do NOT build RichBlock objects.
 */
import { splitChatMessage } from './utils'
import type { InputRichMessage } from 'grammy/types'

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

/**
 * Escape the inline-formatting metacharacters so an interpolated value renders
 * literally instead of as bold/italic/strikethrough/code/link markup. Use when
 * splicing untrusted text into a markdown literal in normal (non-code-span)
 * context. Block-level chars like `.`/`#`/`-` are left alone — they only carry
 * meaning at line start, and escaping them risks stray backslashes.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_~[\]])/g, '\\$1')
}

/**
 * Wrap a value in a markdown code span using a backtick fence longer than any
 * run of backticks inside it, so the value can't break out of the span. Backslash
 * escaping does not work inside code spans, so a longer fence is the only robust
 * option. A pad space lets the span hold values that start or end with a backtick.
 */
export function codeSpan(value: string): string {
  const longestRun = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longestRun + 1)
  const pad = /^`|`$/.test(value) ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
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
