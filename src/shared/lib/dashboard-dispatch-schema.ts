import { z } from 'zod'

/**
 * Dashboard session-dispatch protocol.
 *
 * A dashboard iframe calls `window.__GAMUT_DASHBOARD__.dispatchSession(...)`
 * (injected by `src/api/dashboard-runtime.ts`), which posts a request message
 * to the parent frame. The host app — not the dashboard — owns the rest:
 * it shows a confirmation dialog and only creates a session after the user
 * clicks Dispatch. The dashboard-facing promise settles from the result
 * message. Messages are cross-frame JSON, so the host validates every
 * incoming request against the Zod schema here before acting on it.
 *
 * Flow: request → ack (host speaks the protocol; cancels the shim's
 * availability timeout) → result (dispatched / cancelled / error). A host
 * that never acks (popped-out dashboard window, old app version) causes the
 * shim to reject after a short timeout instead of hanging.
 */

export const DASHBOARD_DISPATCH_REQUEST_TYPE = 'gamut:dispatch-session-request'
export const DASHBOARD_DISPATCH_ACK_TYPE = 'gamut:dispatch-session-ack'
export const DASHBOARD_DISPATCH_RESULT_TYPE = 'gamut:dispatch-session-result'

export const DASHBOARD_DISPATCH_PROMPT_MAX = 8000
export const DASHBOARD_DISPATCH_ID_MAX = 128
export const DASHBOARD_DISPATCH_TITLE_MAX = 200

/** Host-side cooldown after a dialog resolves before the next request is accepted. */
export const DASHBOARD_DISPATCH_COOLDOWN_MS = 2000

/**
 * The consent sentence both hosts render, split around the agent name:
 * `PREFIX + <agent name> + SUFFIX`. Shared so the in-app modal and the /view
 * wrapper can never show divergent consent language.
 */
export const DASHBOARD_DISPATCH_CONSENT_PREFIX = 'This dashboard wants to start a new session on '
export const DASHBOARD_DISPATCH_CONSENT_SUFFIX =
  '. Review the prompt before dispatching — it runs in the background.'

export const dashboardDispatchRequestSchema = z.object({
  type: z.literal(DASHBOARD_DISPATCH_REQUEST_TYPE),
  id: z.string().min(1).max(DASHBOARD_DISPATCH_ID_MAX),
  // Sessions always run on the agent that owns the dashboard — there is
  // deliberately no agent field. Slash-command prompts are agent-local, so a
  // redirect would usually break them; cross-agent invocation belongs to the
  // x-agent machinery (ACLs, policy review), not a dispatch dialog.
  payload: z.object({
    prompt: z.string().min(1).max(DASHBOARD_DISPATCH_PROMPT_MAX),
    title: z.string().min(1).max(DASHBOARD_DISPATCH_TITLE_MAX).optional(),
  }),
})

export type DashboardDispatchRequestMessage = z.infer<typeof dashboardDispatchRequestSchema>
export type DashboardDispatchPayload = DashboardDispatchRequestMessage['payload']

export type DashboardDispatchErrorCode = 'busy' | 'rate_limited' | 'invalid_request'

export type DashboardDispatchResult =
  | { sessionId: string; agentSlug: string }
  | { cancelled: true }
  | { error: string; code: DashboardDispatchErrorCode }

/**
 * Optional provenance block on `POST /api/agents/:id/sessions` marking the
 * session as confirmed from a dashboard's dispatch dialog. Client-supplied
 * metadata only — it grants nothing, it just labels the session. The owning
 * agent is NOT client-supplied: the server derives it from the route's own
 * slug (dispatch always targets the owning agent), so it cannot be spoofed.
 */
export const sessionDashboardDispatchSchema = z.object({
  dashboardSlug: z.string().min(1).max(200),
})

export type SessionDashboardDispatch = z.infer<typeof sessionDashboardDispatchSchema>
