/**
 * Session Summary Service
 *
 * Reads a source session's JSONL transcript, builds a budgeted-recency slice
 * (reusing a compact_boundary summary when present), summarizes via the
 * summarizerModel, and composes the injected initialMessage for the new session.
 */

import { getConfiguredLlmClient } from '../llm-provider/helpers'
import { getEffectiveModels } from '../config/settings'
import { withRetry } from '@shared/lib/utils/retry'
import { summaryPayloadSchema } from '../stale-session/stale-session-schema'
import { SUMMARY_INPUT_BUDGET_TOKENS, SUMMARY_MAX_TOKENS, BRANCH_PREAMBLE_SENTINEL, SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS, SUMMARY_OUTPUT_RATIO } from '../stale-session/stale-session-config'
import {
  pruneTranscript,
  budgetPrunedLines,
  renderPrunedLines,
} from './transcript-prune'
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
 * Throws on a malformed/non-JSON response (or ZodError) so the caller can
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

  const res = await withRetry(() => client.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    messages: [{ role: 'user', content: `${SUMMARY_INSTRUCTION}\n\n${transcript}` }],
  }))

  const text = res.content
    .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')

  // Models (Haiku especially) often wrap the JSON in a ```json code fence or add
  // prose around it despite the "TEXT ONLY as JSON" instruction, so extract the
  // JSON object (first { to last }) before parsing rather than assuming the whole
  // reply is clean JSON. JSON.parse / ZodError still propagate so the caller
  // detects failure and returns 502.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`Summarizer returned non-JSON response: ${text.slice(0, 120)}`)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error(`Summarizer returned non-JSON response: ${text.slice(0, 120)}`)
  }
  return summaryPayloadSchema.parse(parsedJson).summary
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
    `${BRANCH_PREAMBLE_SENTINEL} The summary below covers the earlier context.`,
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
    .map((b) => b.text)
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
        if (isMessageEntry(next) && next.isCompactSummary) {
          const summaryText = extractText(next.message.content)
          if (summaryText) priorBoundarySummary = summaryText
          break
        }
      }
      continue
    }

    // Skip system entries, non-message entries, and compact summary injections
    if (!isMessageEntry(entry)) continue
    const msgEntry = entry
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

    transcript.push({ role: msgEntry.type, text })
  }

  return { transcript, priorBoundarySummary }
}

// ============================================================================
// New summarization path (Task 2 — additive; old path above stays in place)
// ============================================================================

const HANDOFF_SUMMARY_INSTRUCTION = `You are summarizing a coding-agent conversation so a fresh session can continue the work seamlessly. Another assistant will read ONLY your summary, so it must carry everything needed to continue and nothing else. Write concise markdown with these sections (omit a section only if it is genuinely empty):

## Goal
The user's overall objective in this conversation.

## Completed work
What was finished, with the key files and outcomes.

## Current state
Files changed and their status; what works, what is broken.

## In progress / Next steps
What was mid-flight and the concrete next actions to take.

## Decisions & constraints
Key technical decisions and why they were made; user preferences and requirements that must persist.

## Critical context
Anything else essential to continue: open errors, gotchas, references.

Be concise but complete. Do not invent. Do not include raw file contents or raw tool output.`

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Summarize a pre-rendered, pruned transcript text into markdown. Returns the
 * model's response text directly -- no JSON envelope, no parsing. The output
 * budget scales with input size, clamped to [floor, cap]. Uses the file's local
 * estTokens (4-char heuristic).
 */
export async function summarizeText(text: string, priorBoundarySummary?: string): Promise<string> {
  const client = getConfiguredLlmClient()
  const model = getEffectiveModels().summarizerModel
  const input = (priorBoundarySummary ? `[Earlier summary]\n${priorBoundarySummary}\n\n` : '') + text
  const maxTokens = clamp(
    Math.round(estTokens(input) * SUMMARY_OUTPUT_RATIO),
    SUMMARY_OUTPUT_FLOOR_TOKENS,
    SUMMARY_OUTPUT_CAP_TOKENS,
  )
  const res = await withRetry(() => client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: `${HANDOFF_SUMMARY_INSTRUCTION}\n\n${input}` }],
  }))
  return res.content
    .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
    .trim()
}

/** Load raw transcript entries plus the latest compact_boundary summary (if any). */
export async function loadTranscriptEntries(
  agentSlug: string,
  fromSessionId: string,
): Promise<{ entries: JsonlEntry[]; priorBoundarySummary?: string }> {
  const jsonlPath = getSessionJsonlPath(agentSlug, fromSessionId)
  const entries = await readJsonlFile<JsonlEntry>(jsonlPath)
  let priorBoundarySummary: string | undefined
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (isSystemEntry(entry) && entry.subtype === 'compact_boundary') {
      for (let j = i + 1; j < entries.length && j <= i + 3; j++) {
        const next = entries[j]
        if (isMessageEntry(next) && next.isCompactSummary) {
          const summaryText = extractText(next.message.content)
          if (summaryText) priorBoundarySummary = summaryText
          break
        }
      }
    }
  }
  return { entries, priorBoundarySummary }
}

/** Orchestrate: load raw entries -> prune -> recency-budget -> render -> summarize. */
export async function summarizeTranscript(agentSlug: string, fromSessionId: string): Promise<string> {
  const { entries, priorBoundarySummary } = await loadTranscriptEntries(agentSlug, fromSessionId)
  const text = renderPrunedLines(budgetPrunedLines(pruneTranscript(entries)))
  return summarizeText(text, priorBoundarySummary)
}

/**
 * Build the initialMessage for the new session from a PRECOMPUTED summary. This is
 * the formatting tail of buildBranchInitialMessage, relocated so it runs at
 * create-on-send. The in-container path line is load-bearing: message-transform's
 * splitter anchors on it to draw the post-send context card. Do not change the
 * shape without updating that splitter.
 */
export function buildSeed(args: { fromSessionId: string; summary: string; userMessage: string }): string {
  return [
    `${BRANCH_PREAMBLE_SENTINEL} The summary below covers the earlier context.`,
    '',
    args.summary,
    '',
    `If you need exact details (code, errors), read the full transcript at: ${IN_CONTAINER_JSONL(args.fromSessionId)}`,
    'Continue directly from where it left off. Do not recap or acknowledge this summary.',
    '',
    '---',
    args.userMessage,
  ].join('\n')
}
