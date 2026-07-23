import { z } from 'zod'

/**
 * Typed model for "the agent is blocked on a human" — one envelope for every
 * pending user-input request regardless of which store currently owns it.
 *
 * Phase 2 (shadow registry): this model mirrors the existing shelves via
 * write-through and is compared against them; nothing reads it for behavior
 * yet. The envelope is strict (we construct it), the per-kind payloads are
 * deliberately lenient (`looseObject` + `.catch`) so a malformed tool input
 * can never make the shadow diverge from the shelf it mirrors.
 */

export const USER_INPUT_REQUEST_KINDS = [
  'question',
  'secret',
  'connected_account',
  'file',
  'remote_mcp',
  'browser_input',
  'script_run',
  'capability_review',
  'computer_use',
  'proxy_review',
  'x_agent_review',
] as const

export const userInputRequestKindSchema = z.enum(USER_INPUT_REQUEST_KINDS)
export type UserInputRequestKind = z.infer<typeof userInputRequestKindSchema>

export const userInputRequestOutcomeSchema = z.enum([
  'answered',
  'declined',
  'cancelled',
  'superseded',
  'timeout',
  'invalidated',
])
export type UserInputRequestOutcome = z.infer<typeof userInputRequestOutcomeSchema>

/** sessionId absent ⇒ agent-scoped (proxy / x-agent reviews). */
const requestScopeSchema = z.object({
  agentSlug: z.string().optional(),
  sessionId: z.string().optional(),
})
export type UserInputRequestScope = z.infer<typeof requestScopeSchema>

const baseRequest = z.object({
  /** toolUseId for stream/computer-use kinds, reviewId for reviews — one namespace. */
  id: z.string().min(1),
  scope: requestScopeSchema,
  /** Whether an open instance of this request keeps the session "awaiting input". */
  blocking: z.boolean(),
  /** Auto-approved asks (e.g. allowlisted script_run) are visible but never block. */
  autoApproved: z.boolean().default(false),
})

const lenientString = z.string().optional().catch(undefined)

export const pendingUserInputRequestSchema = z.discriminatedUnion('kind', [
  baseRequest.extend({
    kind: z.literal('question'),
    payload: z.looseObject({ questions: z.unknown().optional() }),
  }),
  baseRequest.extend({
    kind: z.literal('secret'),
    payload: z.looseObject({ secretName: lenientString, reason: lenientString }),
  }),
  baseRequest.extend({
    kind: z.literal('connected_account'),
    payload: z.looseObject({ toolkit: lenientString, reason: lenientString }),
  }),
  baseRequest.extend({
    kind: z.literal('file'),
    payload: z.looseObject({ description: lenientString, fileTypes: z.unknown().optional() }),
  }),
  baseRequest.extend({
    kind: z.literal('remote_mcp'),
    payload: z.looseObject({
      url: lenientString,
      name: lenientString,
      reason: lenientString,
      authHint: lenientString,
    }),
  }),
  baseRequest.extend({
    kind: z.literal('browser_input'),
    payload: z.looseObject({ message: lenientString, requirements: z.unknown().optional() }),
  }),
  baseRequest.extend({
    kind: z.literal('script_run'),
    payload: z.looseObject({
      script: lenientString,
      explanation: lenientString,
      scriptType: lenientString,
    }),
  }),
  baseRequest.extend({
    kind: z.literal('capability_review'),
    payload: z.looseObject({
      capability: lenientString,
      toolName: lenientString,
      input: z.unknown().optional(),
    }),
  }),
  baseRequest.extend({
    kind: z.literal('computer_use'),
    payload: z.looseObject({
      method: lenientString,
      params: z.record(z.string(), z.unknown()).optional().catch(undefined),
      permissionLevel: lenientString,
      appName: lenientString,
    }),
  }),
  baseRequest.extend({
    kind: z.literal('proxy_review'),
    payload: z.looseObject({
      accountId: lenientString,
      toolkit: lenientString,
      method: lenientString,
      targetPath: lenientString,
      matchedScopes: z.array(z.string()).optional().catch(undefined),
      scopeDescriptions: z.record(z.string(), z.string()).optional().catch(undefined),
      endpointDescription: lenientString,
    }),
  }),
  baseRequest.extend({
    kind: z.literal('x_agent_review'),
    payload: z.looseObject({
      accountId: lenientString,
      toolkit: lenientString,
      method: lenientString,
      targetPath: lenientString,
      matchedScopes: z.array(z.string()).optional().catch(undefined),
      xAgent: z
        .looseObject({
          targetAgentSlug: lenientString,
          targetAgentName: lenientString,
          operation: lenientString,
          preview: lenientString,
        })
        .optional()
        .catch(undefined),
    }),
  }),
])

export type PendingUserInputRequest = z.infer<typeof pendingUserInputRequestSchema>
export type PendingUserInputRequestInput = z.input<typeof pendingUserInputRequestSchema>

/**
 * Which legacy shelf a kind lives on today. The shadow registry uses this to
 * mirror shelf-scoped operations exactly (e.g. the turn-boundary clear wipes
 * only the stream shelf; a stray tool_result must never evict a computer-use
 * entry the shelf still holds).
 */
export type UserInputRequestShelf = 'stream' | 'computer_use' | 'review'

export function shelfForKind(kind: UserInputRequestKind): UserInputRequestShelf {
  if (kind === 'computer_use') return 'computer_use'
  if (kind === 'proxy_review' || kind === 'x_agent_review') return 'review'
  return 'stream'
}

/** Broadcast event type → request kind, for the persister's SSE-intercept feeder. */
const STREAM_EVENT_TYPE_TO_KIND: Record<string, UserInputRequestKind> = {
  user_question_request: 'question',
  secret_request: 'secret',
  connected_account_request: 'connected_account',
  file_request: 'file',
  remote_mcp_request: 'remote_mcp',
  browser_input_request: 'browser_input',
  script_run_request: 'script_run',
  capability_review_request: 'capability_review',
}

/**
 * Build a registry envelope from a pending-input broadcast event (the exact
 * object the persister stores in `pendingInputRequests`). Returns null for
 * event types that are not user-input requests.
 */
export function streamEventToPendingRequest(
  sessionId: string,
  evt: { type: string; toolUseId: string; [k: string]: unknown },
): PendingUserInputRequestInput | null {
  const kind = STREAM_EVENT_TYPE_TO_KIND[evt.type]
  if (!kind) return null
  const { type: _type, toolUseId: _toolUseId, agentSlug, autoApproved, ...payload } = evt
  return {
    id: evt.toolUseId,
    kind,
    scope: {
      agentSlug: typeof agentSlug === 'string' ? agentSlug : undefined,
      sessionId,
    },
    blocking: true,
    autoApproved: autoApproved === true,
    payload,
  } as PendingUserInputRequestInput
}
