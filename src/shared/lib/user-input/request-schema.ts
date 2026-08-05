import { z } from 'zod'

/**
 * Typed model for "the agent is blocked on a human" — one envelope for every
 * pending user-input request. The envelope is strict (we construct it), the
 * per-kind payloads are deliberately lenient (`looseObject` + `.catch`) so a
 * malformed tool input can never break the delivery path that carries it —
 * the server keeps the wait alive even when the payload is unrenderable.
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
  /**
   * The Task tool_use that spawned the asking subagent, when the request came
   * from a sidechain. Subagent termination invalidates every open request
   * registered under its parent — without this linkage a dead subagent's card
   * is orphaned until a coarser boundary clears it.
   */
  parentToolUseId: z.string().optional(),
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
    payload: z.looseObject({
      message: lenientString,
      requirements: z.unknown().optional(),
      // Captured by the host harness when the request opens. This is not part
      // of the model-facing tool input: the browser itself remains the source
      // of truth for credential scoping.
      browserContext: z.looseObject({
        url: z.string(),
        capturedAt: z.number(),
      }).optional().catch(undefined),
    }),
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
 * The lifecycle class of a kind. The names come from the pre-registry stores,
 * but what they express is per-class clearing rules: the turn-boundary clear
 * wipes only 'stream' entries, 'computer_use' entries survive idle for replay
 * and are superseded on the next active turn, and 'review' entries are
 * agent-scoped and outlive any one session. A stray tool_result must never
 * evict an entry of another class.
 */
export type UserInputRequestStore = 'stream' | 'computer_use' | 'review'

/**
 * Whether a request may be sent to clients (wire events, snapshots). Entries
 * synthesized by transcript recovery carry no renderable payload — sending one
 * would draw a broken card; the transcript renders those instead.
 */
export function isReplayableUserInputRequest(request: PendingUserInputRequest): boolean {
  return (request.payload as Record<string, unknown>).recovered !== true
}

export function storeForKind(kind: UserInputRequestKind): UserInputRequestStore {
  if (kind === 'computer_use') return 'computer_use'
  if (kind === 'proxy_review' || kind === 'x_agent_review') return 'review'
  return 'stream'
}
