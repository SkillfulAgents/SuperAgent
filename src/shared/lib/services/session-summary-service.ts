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
import { BRANCH_PREAMBLE_SENTINEL, SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS, SUMMARY_OUTPUT_RATIO } from '../stale-session/stale-session-config'
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

// ============================================================================
// New summarization path (Task 2)
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
