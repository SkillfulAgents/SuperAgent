# Stale-session prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user sends a message into a stale session (idle >6h or current context >150k tokens), prompt them to start a new topic, continue in a fresh session carrying a summary, or send here anyway — to teach the session model and cut per-message cost.

**Architecture:** Client-side trigger gate in the message composer decides *whether* to prompt (it already has every signal). One new server endpoint generates the summary (budgeted-recency, reusing existing compaction summaries) and creates the branched session with an injected first message. Thresholds are code constants. Zod validates every boundary.

**Tech Stack:** React 18, Hono, TypeScript, Zod, Vitest (unit), Playwright (e2e), `@anthropic-ai/sdk`. Sessions are file-based (no DB changes).

**Spec:** `docs/superpowers/specs/2026-06-15-stale-session-prompt-design.md` (read it first — it carries the decisions and rationale).

**Plan structure:** Tasks 1-5 (shared core + server) ship full code + tests. Tasks 6-11 (route/UI wiring) give exact integration points and contracts; their first step is always "read the named file" because they edit existing files referenced by line number. Don't skip the read — match the file's real prop/return shapes.

**Conventions:**
- Path alias `@shared/*` → `src/shared/*`.
- Per CLAUDE.md: do NOT run `npm run build` (breaks the dev server). Verify with `npm run typecheck` and `npm run lint`.
- Single unit test: `npx vitest run <path>`. Full unit suite: `npm run test:run`.
- E2E (always tee): `E2E_MOCK=true npx playwright test <spec> 2>&1 | tee /tmp/e2e-results.txt`.
- Commit after each task. Branch is `feat/stale-session-prompt`.

---

## File Structure

**New files:**
- `src/shared/lib/stale-session/stale-session-config.ts` — tunable threshold constants.
- `src/shared/lib/stale-session/stale-session-trigger.ts` — pure trigger decision + context-occupancy helper.
- `src/shared/lib/stale-session/stale-session-trigger.test.ts` — trigger unit tests.
- `src/shared/lib/stale-session/stale-session-schema.ts` — Zod schemas (branch request, summary payload).
- `src/shared/lib/stale-session/message-cost.ts` — `estimateMessageCost` extracted/shared from usage pricing.
- `src/shared/lib/stale-session/message-cost.test.ts` — cost unit tests.
- `src/shared/lib/services/session-summary-service.ts` — read jsonl, budgeted-recency summary, compose injected message.
- `src/shared/lib/services/session-summary-service.test.ts` — summary unit tests (LLM mocked).
- `src/renderer/components/messages/stale-session-prompt.tsx` — the modal (Variant A).
- `e2e/stale-session-prompt.spec.ts` — E2E.

**Modified files:**
- `src/shared/lib/services/usage-service.ts` — export the per-token cost primitive for reuse (Task 2).
- `src/shared/lib/types/agent.ts` — add `stalePromptDismissed?: boolean` to `SessionMetadata` (Task 7).
- `src/api/routes/agents.ts` — add `POST /sessions/branch`; extend session-update to accept the dismissal flag (Tasks 6, 7).
- `src/renderer/components/messages/message-input.tsx` — trigger gate in `onSubmit` (Task 9).
- `src/renderer/hooks/use-sessions.ts` — `useBranchSession` + `useDismissStalePrompt` mutations (Task 8).
- `src/renderer/components/layout/main-content.tsx` — pass staleness signals into `MessageInput` (Task 9).
- `src/shared/lib/utils/message-transform.ts` (+ renderer message component) — render the carried-context marker as a collapsed card (Task 11).

---

## Task 1: Threshold constants

**Files:**
- Create: `src/shared/lib/stale-session/stale-session-config.ts`

- [ ] **Step 1: Write the constants module**

```ts
// Tunable in code only (not user settings, not UI). Calibrate from real usage.
// See docs/superpowers/specs/2026-06-15-stale-session-prompt-design.md.

/** Idle gap after which a returning user is prompted. Default 6h. */
export const STALE_TIME_GAP_MS = 6 * 60 * 60 * 1000

/** Current context occupancy (tokens) above which the session is "expensive now". */
export const STALE_CONTEXT_TOKENS = 150_000

/** Token budget for what we feed the summarizer (Haiku ~200k window minus headroom
 *  for the instruction + output). */
export const SUMMARY_INPUT_BUDGET_TOKENS = 150_000

/** Max wait for summary generation before treating it as a failure. */
export const SUMMARY_TIMEOUT_MS = 15_000
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add src/shared/lib/stale-session/stale-session-config.ts
git commit -m "feat(stale-session): add tunable threshold constants"
```

---

## Task 2: Shared message-cost helper

Reuse the pricing math already in `usage-service.ts` (`MODEL_PRICING` from `model-pricing.json`, rates per model: `{ input, output, cacheCreation, cacheRead }`). Do NOT duplicate the math — extract it.

**Files:**
- Modify: `src/shared/lib/services/usage-service.ts`
- Create: `src/shared/lib/stale-session/message-cost.ts`
- Create: `src/shared/lib/stale-session/message-cost.test.ts`

- [ ] **Step 1: Read `usage-service.ts:55-260`** to see the exact `MODEL_PRICING` shape, the rate units (per-token vs per-million), and the existing cost computation around line 247. The helper below must mirror those units exactly.

- [ ] **Step 2: Write the failing test** (`message-cost.test.ts`). Replace `RATE_*` expectations after Step 1 with values derived from the real `model-pricing.json` entry you read.

```ts
import { describe, it, expect } from 'vitest'
import { estimateNextMessageCostUsd } from './message-cost'

describe('estimateNextMessageCostUsd', () => {
  it('prices a cold-cache re-read at the cache-creation rate (idle session)', () => {
    // 150k tokens of context re-read, idle => cache creation on the whole context.
    const usd = estimateNextMessageCostUsd({ contextTokens: 150_000, model: 'claude-sonnet-4-6', idle: true })
    expect(usd).toBeGreaterThan(0)
  })

  it('returns null for an unknown model rather than throwing', () => {
    expect(estimateNextMessageCostUsd({ contextTokens: 150_000, model: 'made-up-model', idle: true })).toBeNull()
  })

  it('costs more cold (cache-creation) than warm (cache-read)', () => {
    const cold = estimateNextMessageCostUsd({ contextTokens: 100_000, model: 'claude-sonnet-4-6', idle: true })!
    const warm = estimateNextMessageCostUsd({ contextTokens: 100_000, model: 'claude-sonnet-4-6', idle: false })!
    expect(cold).toBeGreaterThan(warm)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/stale-session/message-cost.test.ts`
Expected: FAIL ("estimateNextMessageCostUsd is not a function").

- [ ] **Step 4: Export the pricing primitive from `usage-service.ts`.** If `usage-service.ts` has a private per-token cost function, `export` it (and the `MODEL_PRICING` accessor). If the cost is inline, extract a small exported function `getModelPricing(model): { input; output; cacheCreation; cacheRead } | undefined`. Keep existing call sites working.

- [ ] **Step 5: Write `message-cost.ts`.** Use the real rate units from Step 1 (this assumes per-token rates; if `model-pricing.json` is per-million, divide by 1_000_000).

```ts
import { getModelPricing } from '../services/usage-service'
import type { SessionUsage } from '../types/agent'

/** Current context occupancy ≈ what the next message re-reads (last turn's input side). */
export function currentContextTokens(usage: Pick<SessionUsage,
  'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> | null | undefined): number {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
}

/** Rough USD cost of sending the next message: re-reading `contextTokens` of context.
 *  Idle => cold cache => cache-creation rate on the whole context (the honest "cost to come back").
 *  Output excluded (unpredictable; input dominates for the sessions we prompt on). Null if model unknown. */
export function estimateNextMessageCostUsd(
  { contextTokens, model, idle }: { contextTokens: number; model: string; idle: boolean },
): number | null {
  const p = getModelPricing(model)
  if (!p) return null
  const inputRate = idle ? p.cacheCreation : p.cacheRead
  return contextTokens * inputRate
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/stale-session/message-cost.test.ts`
Expected: PASS. Then `npm run typecheck` PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/lib/services/usage-service.ts src/shared/lib/stale-session/message-cost.ts src/shared/lib/stale-session/message-cost.test.ts
git commit -m "feat(stale-session): shared next-message cost + context-occupancy helpers"
```

---

## Task 3: Pure trigger decision

**Files:**
- Create: `src/shared/lib/stale-session/stale-session-trigger.ts`
- Create: `src/shared/lib/stale-session/stale-session-trigger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { evaluateStalePrompt } from './stale-session-trigger'
import { STALE_TIME_GAP_MS, STALE_CONTEXT_TOKENS } from './stale-session-config'

const base = { idleMs: 0, contextTokens: 0, isAwaitingInput: false, isRunning: false, dismissed: false }

describe('evaluateStalePrompt', () => {
  it('does not prompt a fresh, small, active session', () => {
    expect(evaluateStalePrompt(base).shouldPrompt).toBe(false)
  })
  it('prompts (reason=idle) past the idle gap', () => {
    const r = evaluateStalePrompt({ ...base, idleMs: STALE_TIME_GAP_MS + 1 })
    expect(r).toEqual({ shouldPrompt: true, reason: 'idle' })
  })
  it('prompts (reason=size) past the token threshold', () => {
    const r = evaluateStalePrompt({ ...base, contextTokens: STALE_CONTEXT_TOKENS + 1 })
    expect(r).toEqual({ shouldPrompt: true, reason: 'size' })
  })
  it('suppresses while awaiting a permission/tool decision, even when stale', () => {
    expect(evaluateStalePrompt({ ...base, idleMs: STALE_TIME_GAP_MS + 1, isAwaitingInput: true }).shouldPrompt).toBe(false)
  })
  it('suppresses while actively running', () => {
    expect(evaluateStalePrompt({ ...base, contextTokens: STALE_CONTEXT_TOKENS + 1, isRunning: true }).shouldPrompt).toBe(false)
  })
  it('suppresses once dismissed for the session', () => {
    expect(evaluateStalePrompt({ ...base, idleMs: STALE_TIME_GAP_MS + 1, dismissed: true }).shouldPrompt).toBe(false)
  })
  it('prefers size as the reason when both fire', () => {
    const r = evaluateStalePrompt({ ...base, idleMs: STALE_TIME_GAP_MS + 1, contextTokens: STALE_CONTEXT_TOKENS + 1 })
    expect(r.reason).toBe('size')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/stale-session/stale-session-trigger.test.ts`
Expected: FAIL ("evaluateStalePrompt is not a function").

- [ ] **Step 3: Write the implementation**

```ts
import { STALE_TIME_GAP_MS, STALE_CONTEXT_TOKENS } from './stale-session-config'

export type StaleReason = 'idle' | 'size'

export interface StaleInput {
  idleMs: number          // now - lastActivityAt
  contextTokens: number   // currentContextTokens(lastUsage)
  isAwaitingInput: boolean
  isRunning: boolean
  dismissed: boolean      // SessionMetadata.stalePromptDismissed
}

export interface StaleDecision {
  shouldPrompt: boolean
  reason: StaleReason | null
}

export function evaluateStalePrompt(i: StaleInput): StaleDecision {
  if (i.dismissed || i.isAwaitingInput || i.isRunning) return { shouldPrompt: false, reason: null }
  const bySize = i.contextTokens > STALE_CONTEXT_TOKENS
  const byIdle = i.idleMs > STALE_TIME_GAP_MS
  if (bySize) return { shouldPrompt: true, reason: 'size' } // size leads the copy when both fire
  if (byIdle) return { shouldPrompt: true, reason: 'idle' }
  return { shouldPrompt: false, reason: null }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/stale-session/stale-session-trigger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/stale-session/stale-session-trigger.ts src/shared/lib/stale-session/stale-session-trigger.test.ts
git commit -m "feat(stale-session): pure trigger decision helper"
```

---

## Task 4: Zod schemas

**Files:**
- Create: `src/shared/lib/stale-session/stale-session-schema.ts`

- [ ] **Step 1: Read** an existing route schema (e.g. `src/api/routes/x-agent.ts:210-214`) to match the project's Zod style and import path (`zod`).

- [ ] **Step 2: Write the schemas**

```ts
import { z } from 'zod'

/** Body for POST /api/agents/:id/sessions/branch */
export const branchSessionRequestSchema = z.object({
  fromSessionId: z.string().min(1),
  message: z.string().min(1),         // the user's original typed message
  model: z.string().optional(),       // inherited from source session if omitted
  effort: z.string().optional(),
})
export type BranchSessionRequest = z.infer<typeof branchSessionRequestSchema>

/** Structured output we require from the summarizer model. */
export const summaryPayloadSchema = z.object({
  summary: z.string().min(1),
})
export type SummaryPayload = z.infer<typeof summaryPayloadSchema>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/lib/stale-session/stale-session-schema.ts
git commit -m "feat(stale-session): zod schemas for branch request and summary payload"
```

---

## Task 5: Session summary service

Reads the source session's jsonl, builds a budgeted-recency transcript (reusing an embedded `compact_boundary` summary when present), summarizes via `summarizerModel`, and composes the new session's `initialMessage`.

**Files:**
- Create: `src/shared/lib/services/session-summary-service.ts`
- Create: `src/shared/lib/services/session-summary-service.test.ts`

- [ ] **Step 1: Read these to confirm exact signatures:**
  - `src/shared/lib/utils/file-storage.ts:431-441` — `getSessionJsonlPath(agentSlug, sessionId)` and the in-container path shape `.claude/projects/-workspace/{sessionId}.jsonl`.
  - `src/shared/lib/services/session-service.ts` — `readJsonlFile` (entry parsing) and `JsonlMessageEntry` (`types/agent.ts:133-147`: `{ type, timestamp, message: { role, content[], usage? } }`).
  - `src/shared/lib/utils/message-transform.ts` — how a `compact_boundary` / `isCompactSummary` entry is identified in the raw jsonl (reuse that detection).
  - `src/shared/lib/llm-provider/helpers.ts:15-20` — `getConfiguredLlmClient()`; and `agent-template-service.ts` for the `client.messages.create({ model, max_tokens, ...json_schema })` + `extractTextFromLlmResponse` + `withRetry` pattern.
  - `src/shared/lib/config/settings.ts` — `getEffectiveModels().summarizerModel`.

- [ ] **Step 2: Write the failing test** (LLM + filesystem mocked). Adjust mock paths to the real module names found in Step 1.

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"summary":"Was wiring auth; just added rate limiting."}' }] }) },
  }),
}))

import { buildBranchInitialMessage } from './session-summary-service'

describe('buildBranchInitialMessage', () => {
  it('composes preamble + summary + in-container jsonl path + user message', async () => {
    const out = await buildBranchInitialMessage({
      agentSlug: 'atlas', fromSessionId: 'sess-1', userMessage: 'add rate limiting',
      transcript: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'done' }],
    })
    expect(out).toContain('Was wiring auth')                              // summary
    expect(out).toContain('.claude/projects/-workspace/sess-1.jsonl')    // in-container path
    expect(out).toContain('add rate limiting')                            // user message
    expect(out.toLowerCase()).toContain('continue')                       // continue-silently framing
  })

  it('throws on a malformed model response (Zod) so the caller can fall back', async () => {
    // Re-mock create() to return non-JSON, assert buildBranchInitialMessage rejects.
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/services/session-summary-service.test.ts`
Expected: FAIL ("buildBranchInitialMessage is not a function").

- [ ] **Step 4: Write the service.** Keep it small and single-purpose.

```ts
import { getConfiguredLlmClient } from '../llm-provider/helpers'
import { getEffectiveModels } from '../config/settings'
import { summaryPayloadSchema } from '../stale-session/stale-session-schema'
import { SUMMARY_INPUT_BUDGET_TOKENS } from '../stale-session/stale-session-config'

interface TranscriptMsg { role: 'user' | 'assistant'; text: string }

const IN_CONTAINER_JSONL = (sessionId: string) => `.claude/projects/-workspace/${sessionId}.jsonl`
const estTokens = (s: string) => Math.ceil(s.length / 4) // cheap heuristic; replace if a tokenizer util exists

/** Walk messages newest-first up to the budget. Returns chronological order. */
export function budgetedRecentSlice(msgs: TranscriptMsg[], budget = SUMMARY_INPUT_BUDGET_TOKENS): TranscriptMsg[] {
  const kept: TranscriptMsg[] = []
  let used = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = estTokens(msgs[i].text)
    if (used + t > budget && kept.length > 0) break
    kept.unshift(msgs[i]); used += t
  }
  return kept
}

const SUMMARY_INSTRUCTION =
  'Summarize the conversation below so another instance can continue it. ' +
  'Capture: what the user is working on, key decisions, current state, and what they are now asking. ' +
  'Respond with TEXT ONLY as JSON {"summary": "..."}. Do not call tools.'

export async function summarize(slice: TranscriptMsg[], priorBoundarySummary?: string): Promise<string> {
  const client = getConfiguredLlmClient()
  const model = getEffectiveModels().summarizerModel
  const transcript =
    (priorBoundarySummary ? `[Earlier summary]\n${priorBoundarySummary}\n\n` : '') +
    slice.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n\n')
  const res = await client.messages.create({
    model, max_tokens: 700,
    messages: [{ role: 'user', content: `${SUMMARY_INSTRUCTION}\n\n${transcript}` }],
  })
  const text = res.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')
  return summaryPayloadSchema.parse(JSON.parse(text)).summary
}

export async function buildBranchInitialMessage(args: {
  agentSlug: string; fromSessionId: string; userMessage: string
  transcript: TranscriptMsg[]; priorBoundarySummary?: string
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
```

- [ ] **Step 5: Add a transcript loader** in the same file (real I/O, not unit-tested here — covered by E2E): `loadTranscript(agentSlug, fromSessionId): { transcript: TranscriptMsg[]; priorBoundarySummary?: string }` using `getSessionJsonlPath` + `readJsonlFile`, mapping each `JsonlMessageEntry` to `{ role, text }` (join text content parts), and capturing the latest `compact_boundary` entry's `summary` as `priorBoundarySummary`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/shared/lib/services/session-summary-service.test.ts`
Expected: PASS. Then `npm run typecheck` PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/lib/services/session-summary-service.ts src/shared/lib/services/session-summary-service.test.ts
git commit -m "feat(stale-session): session summary service (budgeted recency + injected message)"
```

---

## Task 6: Branch endpoint

**Files:**
- Modify: `src/api/routes/agents.ts` (near the existing `POST /sessions` at `:1273-1376`)

- [ ] **Step 1: Read `agents.ts:1273-1376`** (existing create-session handler) to copy its exact create flow: `client.createSession({ initialMessage, initialMessageUuid, ... })` → `registerSession(slug, sessionId, name)` → response shape `{ id, agentSlug, name, createdAt, ... , initialMessageUuid }`.

- [ ] **Step 2: Add `POST /api/agents/:id/sessions/branch`.** Validate with `branchSessionRequestSchema`. Steps inside:
  1. `loadTranscript(slug, fromSessionId)` (Task 5).
  2. `initialMessage = await buildBranchInitialMessage({ agentSlug: slug, fromSessionId, userMessage: message, ...transcript })`.
  3. Inherit `model`/`effort` from the source session metadata when not provided in the body.
  4. Create the session exactly as the existing `POST /sessions` handler does, passing this `initialMessage`.
  5. Respond `201` with the same session shape + `initialMessageUuid`.
  - On summarization error: respond `502 { error: 'summary_failed' }` (the client keeps the modal open with Retry). Do NOT create a session in this case.

- [ ] **Step 3: Manual smoke (dev server already running per CLAUDE.md):**

Run:
```bash
curl -s -X POST "http://localhost:47891/api/agents/<slug>/sessions/branch" \
  -H 'Content-Type: application/json' \
  -d '{"fromSessionId":"<existing-session>","message":"continue please"}' | head -c 400
```
Expected: `201` JSON with a new session `id`, or `502 {"error":"summary_failed"}`.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/agents.ts
git commit -m "feat(stale-session): POST /sessions/branch endpoint"
```

---

## Task 7: Per-session dismissal persistence

**Files:**
- Modify: `src/shared/lib/types/agent.ts` (`SessionMetadata`, `:78-108`)
- Modify: `src/api/routes/agents.ts` (the existing session-update / PATCH handler that sets `starred`/`name`)

- [ ] **Step 1: Read** `types/agent.ts:78-108` and find the session-update handler in `agents.ts` (the one that writes `starred`/`name` into `session-metadata.json`).

- [ ] **Step 2: Add the field**

```ts
// SessionMetadata
stalePromptDismissed?: boolean
```

- [ ] **Step 3: Accept it in the session-update endpoint.** Extend that handler's Zod body (or the existing validation) with `stalePromptDismissed: z.boolean().optional()` and persist it the same way `starred` is persisted. Surface it on the session GET response so the client can read it (add to `ApiSession` if needed, `types/api.ts:85`).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/types/agent.ts src/shared/lib/types/api.ts src/api/routes/agents.ts
git commit -m "feat(stale-session): persist per-session dismissal flag"
```

---

## Task 8: Client mutations

**Files:**
- Modify: `src/renderer/hooks/use-sessions.ts` (`:35-61` has `useCreateSession`)

- [ ] **Step 1: Read `use-sessions.ts:35-61`** to match the `useMutation` + query-invalidation style.

- [ ] **Step 2: Add `useBranchSession`** — POSTs `/api/agents/{agentSlug}/sessions/branch` with `{ fromSessionId, message, model?, effort? }`, returns `ApiSession & { initialMessageUuid }`, invalidates the sessions list on success (mirror `useCreateSession`).

- [ ] **Step 3: Add `useDismissStalePrompt`** — PATCHes the session-update endpoint with `{ stalePromptDismissed: true }` for `{ agentSlug, sessionId }`, invalidates that session.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/use-sessions.ts
git commit -m "feat(stale-session): useBranchSession + useDismissStalePrompt"
```

---

## Task 9: Trigger gate in the composer

**Files:**
- Modify: `src/renderer/components/messages/message-input.tsx` (`onSubmit` at `:64-92`)
- Modify: `src/renderer/components/layout/main-content.tsx` (renders `MessageInput`; has `useSession` `:68`, `contextUsage` `:98`, `useAgent` `:66`)

- [ ] **Step 1: Read both files.** In `main-content.tsx` confirm available data: `session.lastActivityAt`, `contextUsage` (current usage), `agent.name`, and the awaiting/running state (from `useMessageStream` / `agent-activity-indicator.tsx:56-63`). Confirm `MessageInput`'s current props.

- [ ] **Step 2: Pass staleness signals into `MessageInput`** as props: `lastActivityAt: Date | null`, `contextUsage: SessionUsage | null`, `isAwaitingInput: boolean`, `isRunning: boolean`, `stalePromptDismissed: boolean`, `agentName: string`, `model: string`.

- [ ] **Step 3: Gate `onSubmit`.** Before `sendMessage.mutateAsync(...)`, compute the decision and intercept:

```ts
import { evaluateStalePrompt } from '@shared/lib/stale-session/stale-session-trigger'
import { currentContextTokens } from '@shared/lib/stale-session/message-cost'

const decision = evaluateStalePrompt({
  idleMs: lastActivityAt ? Date.now() - lastActivityAt.getTime() : 0,
  contextTokens: currentContextTokens(contextUsage),
  isAwaitingInput, isRunning, dismissed: stalePromptDismissed,
})
if (decision.shouldPrompt) {
  setPendingContent(content)          // stash the typed message
  setStaleReason(decision.reason)     // 'idle' | 'size'
  setStalePromptOpen(true)
  return                              // do NOT send yet
}
// else: existing send path unchanged
```

(Brand-new sessions never reach this — the new-session composer is `agent-home.tsx`, a different component.)

- [ ] **Step 4: Manual verify (dev server running).** Open a session whose `lastActivityAt` is >6h old (or temporarily lower `STALE_TIME_GAP_MS` to `60_000`), type and send → the modal opens instead of sending. Restore the constant after.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/messages/message-input.tsx src/renderer/components/layout/main-content.tsx
git commit -m "feat(stale-session): gate composer submit on stale-session trigger"
```

---

## Task 10: The prompt modal

**Files:**
- Create: `src/renderer/components/messages/stale-session-prompt.tsx`
- Modify: `src/renderer/components/messages/message-input.tsx` (render it + wire actions)

- [ ] **Step 1: Read `mount-choice-dialog.tsx:20-69`** and `ui/alert-dialog.tsx` for the exact AlertDialog usage and class conventions. Match them.

- [ ] **Step 2: Write the modal.** Copy + structure from the approved mockup (`~/.gstack/projects/JeremyBischoff-SuperAgent/designs/stale-session-prompt-20260615/stale-session-prompt-mockups.html`, Variant A). Props/contract:

```tsx
import { formatTokens } from '@renderer/components/messages/subagent-block' // or wherever formatTokens lives
import { estimateNextMessageCostUsd } from '@shared/lib/stale-session/message-cost'

interface StaleSessionPromptProps {
  open: boolean
  agentName: string
  reason: 'idle' | 'size'
  contextTokens: number
  model: string
  isSummarizing: boolean
  error: string | null
  onContinueSummary: () => void  // calls useBranchSession then navigates
  onNewTopic: () => void         // calls useCreateSession then navigates
  onSendHere: () => void         // dismiss + send in current session
  onRetry: () => void
  onOpenChange: (open: boolean) => void
}
```

Behavior in the component:
- Header text is `reason`-driven (size → "This chat is holding ~{formatTokens(contextTokens)} in context. Your next message re-reads all of it — about ${cost}…"; idle → "Last active … If this is a new topic, a fresh chat keeps {agentName} focused."). Use `estimateNextMessageCostUsd({ contextTokens, model, idle: true })`; if it returns `null`, omit the dollar figure and show tokens only.
- Three options exactly as Variant A: "Continue from a summary" (recommended/default; shows spinner + "Carrying over context…" when `isSummarizing`), "Start a new topic with {agentName}", "Send here anyway" (note: "We won't ask again in this one").
- When `error` is set: show the inline error and keep all three actions, with "Continue from a summary" relabeled to allow Retry (`onRetry`).

- [ ] **Step 3: Wire actions in `message-input.tsx`** using the Task 8 hooks and the navigation from `selection-context.tsx` (`setView({ kind: 'session', id })`):
  - `onContinueSummary`: set `isSummarizing`, call `branchSession.mutateAsync({ fromSessionId: sessionId, message: pendingContent, model })`; on success `setView({kind:'session', id: res.id})` + close; on error set `error` (stay open).
  - `onNewTopic`: `createSession.mutateAsync({ agentSlug, message: pendingContent })` → navigate → close.
  - `onSendHere`: `dismissStalePrompt.mutateAsync({ agentSlug, sessionId })`, then run the original `sendMessage` path with `pendingContent`, close.
  - Add a `SUMMARY_TIMEOUT_MS` guard around the branch call (treat timeout as `error`).

- [ ] **Step 4: Manual verify** each of the three buttons end-to-end against the dev server.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/messages/stale-session-prompt.tsx src/renderer/components/messages/message-input.tsx
git commit -m "feat(stale-session): prompt modal (Variant A) + action wiring"
```

---

## Task 11: Collapsed carried-context card

**Files:**
- Modify: `src/shared/lib/utils/message-transform.ts`
- Modify: the renderer message component that renders `compact_boundary` (find via `ApiCompactBoundary` usage, `types/api.ts:177-184`)

- [ ] **Step 1: Read** `message-transform.ts` and the component that renders a `compact_boundary` today, to learn how that collapsed card is produced.

- [ ] **Step 2: Mark the injected first message.** In `buildBranchInitialMessage` (Task 5) the payload already has a stable preamble. Add a parse rule in `message-transform.ts`: a first user message starting with the preamble sentinel ("This conversation is continued from a previous session.") is split into (a) a `compact_boundary`-style carried-context block (everything up to the `---` line, summary collapsible) and (b) the real user message (after `---`), rendered normally.

- [ ] **Step 3: Reuse the existing `compact_boundary` visual** for block (a) with a "Continued from previous session" label.

- [ ] **Step 4: Manual verify** the branched session shows a collapsed card + the user's message as a normal bubble.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/lib/utils/message-transform.ts
git commit -m "feat(stale-session): render carried context as a collapsed card"
```

---

## Task 12: End-to-end tests

**Files:**
- Create: `e2e/stale-session-prompt.spec.ts`

- [ ] **Step 1: Read** an existing spec under `e2e/` to match the mock-mode harness (`E2E_MOCK=true`), session seeding, and selectors. Reuse the agent/session factory used elsewhere.

- [ ] **Step 2: Write the scenarios** (use the factory to seed sessions with controlled `lastActivityAt` / `lastUsage`):
  1. Stale-by-idle session → sending opens the prompt; "Send here anyway" sends into the same session and a second send does NOT re-open the prompt (dismissal persists).
  2. Stale-by-size session → prompt opens; "Continue from a summary" navigates to a NEW session containing a collapsed carried-context card + the typed message.
  3. Session with `isAwaitingInput` true → sending does NOT open the prompt (suppressed).
  4. Fresh small recent session → no prompt.

- [ ] **Step 3: Run**

Run: `E2E_MOCK=true npx playwright test e2e/stale-session-prompt.spec.ts 2>&1 | tee /tmp/e2e-results.txt`
Expected: all scenarios PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/stale-session-prompt.spec.ts
git commit -m "test(stale-session): e2e for trigger, suppression, actions, dismissal"
```

---

## Final verification

- [ ] `npm run typecheck` PASS
- [ ] `npm run lint` PASS
- [ ] `npm run test:run` PASS (all new unit tests green)
- [ ] `E2E_MOCK=true npx playwright test e2e/stale-session-prompt.spec.ts 2>&1 | tee /tmp/e2e-results.txt` PASS
- [ ] Manual: idle>threshold prompt; size>threshold prompt; awaiting-permission suppressed; each of the 3 actions lands correctly; dismissal sticks per session; cost/token line shows accurate next-message numbers.
- [ ] Confirm `STALE_CONTEXT_TOKENS` (150k) actually trips relative to where auto-compact caps context; note if it needs lowering toward ~100-120k.
