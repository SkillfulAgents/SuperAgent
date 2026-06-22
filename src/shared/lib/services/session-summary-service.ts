/**
 * Session Summary Service
 *
 * Reads a source session's JSONL transcript, builds a budgeted-recency slice
 * (reusing a compact_boundary summary when present), summarizes via the
 * summarizerModel, and composes the injected initialMessage for the new session.
 */

import { getConfiguredLlmClient } from '../llm-provider/helpers'
import { resolveActiveProviderModel } from '../llm-provider'
import { getEffectiveModels } from '../config/settings'
import { withRetry } from '@shared/lib/utils/retry'
import { BRANCH_PREAMBLE_SENTINEL, SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS, SUMMARY_OUTPUT_RATIO } from '../stale-session/stale-session-config'
import {
  pruneTranscript,
  budgetPrunedLines,
  renderPrunedLines,
  estTokens,
  textFromContent,
  isMessageEntry,
} from './transcript-prune'
import { getSessionJsonlPath, readJsonlFile } from '@shared/lib/utils/file-storage'
import type {
  JsonlEntry,
  JsonlSystemEntry,
} from '@shared/lib/types/agent'

// ============================================================================
// In-container path (load-bearing sentinel — Task 11 parses this exact format)
// ============================================================================

const IN_CONTAINER_JSONL = (sessionId: string) =>
  `.claude/projects/-workspace/${sessionId}.jsonl`

// ============================================================================
// Transcript loader (real I/O — covered by E2E, not unit tests)
// ============================================================================
// estTokens, textFromContent, and isMessageEntry are shared with the prune
// module; import them rather than re-declaring (single source of truth).

function isSystemEntry(entry: JsonlEntry): entry is JsonlSystemEntry {
  return entry.type === 'system'
}

// ============================================================================
// New summarization path (Task 2)
// ============================================================================
//
// Build vs buy: there is no drop-in Anthropic vendor for this flow. Compaction /
// context-editing is observe-only and cannot be triggered on demand from the SDK,
// so it cannot drive a user-initiated, pre-navigation summarize. We prune locally
// (transcript-prune) and summarize here instead. Output is plain markdown rather
// than Structured Outputs because it feeds both a human-readable card and the next
// session seed, so a JSON envelope adds parsing for no gain and reintroduces the
// json-fence parse failure the earlier JSON version hit. The HTTP layer still
// Zod-validates the {summary} response and returns 502 on an empty result.

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

Be concise but complete. Do not invent. Do not include raw file contents or raw tool output.

Preserve exact identifiers verbatim where they matter for continuation: file paths, function and symbol names, commands, and error messages, especially from the most recent activity. Quote them exactly rather than paraphrasing. This is not the same as including raw file contents or tool output, which you must still omit.`

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
  // Resolve the configured summarizer selection against the active provider's
  // catalog (concrete id or bare family alias) instead of sending the raw alias,
  // so summarization stays model/provider-agnostic. Matches the other summarizer
  // call sites (naming, agent-template, skillset, scheduled-tasks).
  const model = resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer')
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
  // Join every text block. The shared extractTextFromLlmResponse helper returns
  // only the first block, which would silently truncate a multi-block summary, so
  // it does not fit here.
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
          const summaryText = textFromContent(next.message.content)
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
  // Nothing to summarize: an empty pruned transcript with no prior boundary summary
  // would send the model only the instruction, inviting a fabricated summary. Return
  // '' so the route surfaces 502 (empty result) and the caller can retry instead of
  // seeding invented context.
  if (!text.trim() && !priorBoundarySummary?.trim()) return ''
  return summarizeText(text, priorBoundarySummary)
}

/**
 * Build the initialMessage for the new session from a PRECOMPUTED summary. This is
 * the formatting tail of the old eager branch path, relocated so it runs at
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
