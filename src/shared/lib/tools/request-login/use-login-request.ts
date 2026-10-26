import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { appendToSessionDraft, useDraftsStore } from '@renderer/context/drafts-context'
import {
  loginContextSchema,
  loginFillResultSchema,
  loginVaultInfoSchema,
  type LoginContext,
  type LoginVaultInfo,
} from './login-request'
import {
  LoginActionError,
  loginRequestKey,
  rememberLoginValues,
  runLoginAction,
  useLoginRequestState,
  type LoginRecovery,
  type LoginRequestState,
} from './login-request-store'

/**
 * The form cannot be drawn: the browser could not use the fields the agent
 * picked (it says why), or this viewer may not answer the request. Final —
 * anything else (still locating, the browser waking up) is retried.
 */
export class LoginContextUnavailable extends Error {
  constructor(
    message: string,
    readonly problems: string[],
    /** The fields are on this app's own page: nothing may be entered there, by form or by hand. */
    readonly forThisApp = false,
  ) {
    super(message)
  }
}

/** Retry a transient failure while the card is up: fast at first, then every 10 s. */
function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000)
}

/**
 * Where the fields are, as the browser found them: the frame's origin (the
 * site shown, and the only one the values can go to) and how each field
 * takes input. The server waits for the agent's tool to finish locating them.
 */
export function useLoginContext(agentSlug: string, sessionId: string, toolUseId: string, enabled = true) {
  return useQuery<LoginContext, Error>({
    queryKey: ['login-request-context', agentSlug, sessionId, toolUseId],
    enabled,
    staleTime: Infinity,
    networkMode: 'always',
    retry: (_failureCount, error) => !(error instanceof LoginContextUnavailable),
    retryDelay,
    queryFn: async () => {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/login-request?toolUseId=${encodeURIComponent(toolUseId)}`,
      )
      const data = await response.json().catch(() => null) as { error?: string; problems?: string[]; reason?: string } | null
      if (response.status === 409 || response.status === 403) {
        throw new LoginContextUnavailable(data?.error || 'The sign-in form is not available', data?.problems ?? [], data?.reason === 'this_app')
      }
      if (!response.ok) throw new Error(data?.error || 'The sign-in form is not ready yet')
      return loginContextSchema.parse(data)
    },
  })
}

/**
 * The viewer's saved accounts for the request's site, their accounts on
 * sign-in providers, and whether other members share the agent. Per viewer:
 * in auth mode the vault is each user's own.
 */
export function useLoginVaultInfo(agentSlug: string, sessionId: string, toolUseId: string, enabled: boolean) {
  return useQuery<LoginVaultInfo, Error>({
    queryKey: ['login-request-vault', agentSlug, sessionId, toolUseId],
    enabled,
    // Like the context: this app's own API, reachable with the network down.
    // The card waits for this answer, so a paused query would hold it forever.
    networkMode: 'always',
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/login-request/vault?toolUseId=${encodeURIComponent(toolUseId)}`,
      )
      const data = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(data?.error || 'Saved accounts could not be loaded')
      return loginVaultInfoSchema.parse(data)
    },
  })
}

/** What goes with the values: saving, the fields of a later step, a saved account. */
export interface LoginFillOptions {
  heldValues?: string[]
  save?: boolean
  username?: string
  accountId?: string
  sharedAgentAcknowledged?: boolean
}

/** "Or sign in with Google, …": one of the viewer's saved accounts, or one entered by email. */
export type LoginViaProvider = { accountId: string } | { providerId: string; username: string }

interface UseLoginActionsArgs {
  agentSlug: string
  sessionId: string
  toolUseId: string
}

/** What the form can do about a refused fill, from the server's `reason`. */
function recoveryOf(data: Record<string, unknown> | null): LoginRecovery | undefined {
  if (data?.reason === 'account_unavailable') return { reason: 'account_unavailable' }
  if (data?.reason === 'fields_needed' && Array.isArray(data.fields)) {
    return { reason: 'fields_needed', fields: data.fields.filter((index): index is number => Number.isInteger(index)) }
  }
  return undefined
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new LoginActionError(typeof data?.error === 'string' ? data.error : 'Request failed', recoveryOf(data))
  return data ?? {}
}

export function useLoginRequestActions({ agentSlug, sessionId, toolUseId }: UseLoginActionsArgs) {
  const key = loginRequestKey(agentSlug, sessionId, toolUseId)
  const state = useLoginRequestState(key)
  const drafts = useDraftsStore()
  const base = `/api/agents/${agentSlug}/sessions/${sessionId}`

  /**
   * Send the user's values to the page: one per context field, in order
   * (empty for one a saved account fills), plus the fields of a later step.
   */
  const fill = (context: LoginContext, values: string[], options: LoginFillOptions = {}) =>
    runLoginAction<LoginRequestState>(key, 'fill', async () => {
      const data = await postJson(`${base}/fill-login`, { toolUseId, origin: context.origin, values, ...options })
      // Answered elsewhere (another window): nothing was sent.
      if (data.alreadySettled) return { status: 'settled' }
      // The browser had closed: kept in the vault for the agent's next try, or not at all.
      if (data.browserClosed === true) {
        const saved = data.saved as { username?: unknown } | undefined
        return { status: 'browser_closed', saved: typeof saved?.username === 'string' ? saved.username : null }
      }
      const result = loginFillResultSchema.parse(data)
      rememberLoginValues(agentSlug, sessionId, context.origin, context.fields, values)
      return { status: 'filled', result }
    })

  /** The user signs in to the site through an account on another site: the agent is told which. */
  const signInVia = (context: LoginContext, provider: LoginViaProvider, sharedAgentAcknowledged: boolean) =>
    runLoginAction<LoginRequestState>(key, 'via', async () => {
      const data = await postJson(`${base}/login-via`, { toolUseId, origin: context.origin, provider, sharedAgentAcknowledged })
      if (data.alreadySettled) return { status: 'settled' }
      const answer = data as { provider?: { site?: unknown; username?: unknown } }
      return {
        status: 'via',
        provider: typeof answer.provider?.username === 'string' ? answer.provider.username : '',
      }
    })

  /** The user signed in on the page themselves. */
  const completeManually = () =>
    runLoginAction<LoginRequestState>(key, 'manual', async () => {
      const data = await postJson(`${base}/complete-login`, { toolUseId, action: 'manual' })
      return data.alreadySettled ? { status: 'settled' } : { status: 'manual' }
    })

  /**
   * Decline: the server stops the turn; a reason is then sent as a message so
   * the agent resumes and acts on it, or kept in the draft if that fails.
   */
  const decline = (reason?: string) =>
    runLoginAction<LoginRequestState>(key, 'decline', async () => {
      const data = await postJson(`${base}/complete-login`, { toolUseId, action: 'decline' })
      if (data.alreadySettled) return { status: 'settled' }
      if (reason) {
        try {
          await postJson(`${base}/messages`, { content: reason })
        } catch {
          appendToSessionDraft(drafts, sessionId, reason, { prepend: false })
        }
      }
      return { status: 'declined' }
    })

  return { state, fill, signInVia, completeManually, decline }
}
