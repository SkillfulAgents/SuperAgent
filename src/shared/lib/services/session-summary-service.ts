/**
 * Session Summary Service
 *
 * Reads a source session's JSONL transcript, builds a budgeted-recency slice
 * (reusing a compact_boundary summary when present), summarizes via the
 * summarizerModel, and composes the injected initialMessage for the new session.
 */

import { getConfiguredLlmClient } from '../llm-provider/helpers'
import { getEffectiveModels } from '../config/settings'
import { summaryPayloadSchema } from '../stale-session/stale-session-schema'
import { SUMMARY_INPUT_BUDGET_TOKENS } from '../stale-session/stale-session-config'
import { getSessionJsonlPath, readJsonlFile } from '@shared/lib/utils/file-storage'
import type {
  JsonlEntry,
  JsonlMessageEntry,
  JsonlSystemEntry,
  ContentBlock,
} from '@shared/lib/types/agent'

// ============================================================================
// Types
// ============================================================================

export interface TranscriptMsg {
  role: 'user' | 'assistant'
  text: string
}

// ============================================================================
// In-container path (load-bearing sentinel — Task 11 parses this exact format)
// ============================================================================

const IN_CONTAINER_JSONL = (sessionId: string) =>
  `.claude/projects/-workspace/${sessionId}.jsonl`

// ============================================================================
// Token estimation
// ============================================================================

/** Cheap character-count heuristic; 4 chars ≈ 1 token. */
function estTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

// ============================================================================
// Budgeted recency slice
// ============================================================================

/**
 * Walk messages newest-first up to SUMMARY_INPUT_BUDGET_TOKENS.
 * Returns entries in original chronological order.
 */
export function budgetedRecentSlice(
  msgs: TranscriptMsg[],
  budget = SUMMARY_INPUT_BUDGET_TOKENS,
): TranscriptMsg[] {
  const kept: TranscriptMsg[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = estTokens(msgs[i].text)
    if (used + t > budget && kept.length > 0) break
    kept.unshift(msgs[i])
    used += t
  }
  return kept
}

// ============================================================================
// Summarizer
// ============================================================================

const SUMMARY_INSTRUCTION =
  'Summarize the conversation below so another instance can continue it. ' +
  'Capture: what the user is working on, key decisions, current state, and what they are now asking. ' +
  'Respond with TEXT ONLY as JSON {"summary": "..."}. Do not call tools.'

/**
 * Call the summarizerModel and return the extracted summary string.
 * Throws (SyntaxError or ZodError) on a malformed response so the caller can
 * detect failure and fall back gracefully.
 */
export async function summarize(
  slice: TranscriptMsg[],
  priorBoundarySummary?: string,
): Promise<string> {
  const client = getConfiguredLlmClient()
  const model = getEffectiveModels().summarizerModel

  const transcript =
    (priorBoundarySummary ? `[Earlier summary]\n${priorBoundarySummary}\n\n` : '') +
    slice.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n\n')

  const res = await client.messages.create({
    model,
    max_tokens: 700,
    messages: [{ role: 'user', content: `${SUMMARY_INSTRUCTION}\n\n${transcript}` }],
  })

  const text = res.content
    .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')

  // Both JSON.parse (SyntaxError) and .parse (ZodError) propagate to the caller.
  return summaryPayloadSchema.parse(JSON.parse(text)).summary
}

// ============================================================================
// Initial message composer (load-bearing sentinel for Task 11)
// ============================================================================

/**
 * Build the initialMessage that will be injected into the new branched session.
 * The opening line "This conversation is continued from a previous session." is a
 * sentinel parsed by Task 11 to render the collapsed context card — keep it verbatim.
 */
export async function buildBranchInitialMessage(args: {
  agentSlug: string
  fromSessionId: string
  userMessage: string
  transcript: TranscriptMsg[]
  priorBoundarySummary?: string
}): Promise<string> {
  const slice = budgetedRecentSlice(args.transcript)
  const summary = await summarize(slice, args.priorBoundarySummary)

  return [
    'This conversation is continued from a previous session. The summary below covers the earlier context.',
    '',
    summary,
    '',
    `If you need exact details (code, errors), read the full transcript at: ${IN_CONTAINER_JSONL(args.fromSessionId)}`,
    'Continue directly from where it left off. Do not recap or acknowledge this summary.',
    '',
    '---',
    args.userMessage,
  ].join('\n')
}

// ============================================================================
// Transcript loader (real I/O — covered by E2E, not unit tests)
// ============================================================================

/** Extract plain text from a content field (string or ContentBlock[]). */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
}

function isMessageEntry(entry: JsonlEntry): entry is JsonlMessageEntry {
  return entry.type === 'user' || entry.type === 'assistant'
}

function isSystemEntry(entry: JsonlEntry): entry is JsonlSystemEntry {
  return entry.type === 'system'
}

/**
 * Load a session transcript from disk.
 *
 * Returns:
 *  - `transcript`: chronological user/assistant messages as { role, text }
 *  - `priorBoundarySummary`: text from the latest compact_boundary, if any
 *
 * Tool-result-only user messages and isCompactSummary injections are excluded
 * from the transcript array (but the boundary summary IS captured).
 */
export async function loadTranscript(
  agentSlug: string,
  fromSessionId: string,
): Promise<{ transcript: TranscriptMsg[]; priorBoundarySummary?: string }> {
  const jsonlPath = getSessionJsonlPath(agentSlug, fromSessionId)
  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)

  const transcript: TranscriptMsg[] = []
  let priorBoundarySummary: string | undefined

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Capture compact_boundary summary from its companion isCompactSummary user entry
    if (isSystemEntry(entry) && entry.subtype === 'compact_boundary') {
      for (let j = i + 1; j < entries.length && j <= i + 3; j++) {
        const next = entries[j]
        if (isMessageEntry(next) && (next as JsonlMessageEntry).isCompactSummary) {
          const summaryText =
            typeof next.message.content === 'string' ? next.message.content : ''
          if (summaryText) priorBoundarySummary = summaryText
          break
        }
      }
      continue
    }

    // Skip system entries, non-message entries, and compact summary injections
    if (!isMessageEntry(entry)) continue
    const msgEntry = entry as JsonlMessageEntry
    if (msgEntry.isCompactSummary) continue

    // Skip tool-result-only user messages
    if (
      msgEntry.type === 'user' &&
      Array.isArray(msgEntry.message.content) &&
      msgEntry.message.content.every((b: ContentBlock) => b.type === 'tool_result')
    ) {
      continue
    }

    const text = extractText(msgEntry.message.content)
    if (!text) continue

    transcript.push({ role: msgEntry.type as 'user' | 'assistant', text })
  }

  return { transcript, priorBoundarySummary }
}
