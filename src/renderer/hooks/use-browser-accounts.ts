import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'

/** A saved account as settings shows it: metadata only, never a value. */
const browserAccountSchema = z.object({
  id: z.string(),
  site: z.string(),
  username: z.string(),
  label: z.string().nullable(),
  origin: z.string(),
  parts: z.array(z.string()),
  via: z.object({ id: z.string(), site: z.string(), username: z.string(), label: z.string().nullable(), providerName: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** An agent said the site rejected it: agents ask the user until its password is entered again. */
  rejectedAt: z.string().nullable(),
  agentSlugs: z.array(z.string()),
  /** The agents granted it, named: some may be ones the user can no longer open. */
  agents: z.array(z.object({ slug: z.string(), name: z.string() })),
  /** The browser types it has a signed-in session saved for, and when it was saved (none from a workspace older than saved sessions). */
  sessions: z.array(z.object({ browserType: z.enum(['container', 'chrome', 'browserbase', 'platform']), capturedAt: z.string() })).default([]),
  /** Sign-in methods beyond its parts: the authenticator app an agent added, and the user's request for one. */
  signInMethods: z.object({
    authenticator: z.object({
      addedAt: z.string(),
      issuer: z.string().nullable(),
      accountName: z.string().nullable(),
      /** What the agent named it on the site. */
      name: z.string().nullable().default(null),
      /** An agent said the site rejected a code from it: agents ask the user for codes. */
      rejectedAt: z.string().nullable(),
    }).nullable(),
    /** The passkeys an agent added: the site each is for, and its names. */
    passkeys: z.array(z.object({
      credentialId: z.string(),
      rpId: z.string(),
      addedAt: z.string(),
      name: z.string().nullable(),
      userName: z.string().nullable(),
    })).default([]),
    /** Agents are asked to add one at their next sign-in with the account. */
    requestedAt: z.string().nullable(),
    /** An agent found none it may add on the site, and why. */
    unavailable: z.object({ at: z.string(), reason: z.string() }).nullable(),
  }).default({ authenticator: null, passkeys: [], requestedAt: null, unavailable: null }),
})
export type BrowserAccount = z.infer<typeof browserAccountSchema>

const accountsResponseSchema = z.object({ accounts: z.array(browserAccountSchema) })

const BROWSER_ACCOUNTS_KEY = ['browser-accounts'] as const

/** The request was refused with a reason the UI can act on (`shared_agent`: confirm, then retry). */
export class BrowserAccountRequestError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message)
  }
}

async function send(url: string, init: RequestInit): Promise<void> {
  const response = await apiFetch(url, init)
  if (response.ok) return
  const data = await response.json().catch(() => null) as { error?: string; reason?: string } | null
  throw new BrowserAccountRequestError(data?.error || 'Request failed', data?.reason)
}

export function useBrowserAccounts() {
  return useQuery({
    queryKey: BROWSER_ACCOUNTS_KEY,
    queryFn: async () => {
      const response = await apiFetch('/api/browser-accounts')
      if (!response.ok) throw new Error('Could not load saved logins')
      return accountsResponseSchema.parse(await response.json()).accounts
    },
  })
}

function useAccountMutation<T>(run: (input: T) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    // Every caller says what went wrong where it happened (and `shared_agent`
    // is a confirmation step, not a failure).
    meta: { skipGlobalErrorToast: true },
    mutationFn: run,
    onSettled: () => queryClient.invalidateQueries({ queryKey: BROWSER_ACCOUNTS_KEY }),
  })
}

/** Let an agent sign in with an account. Refused with reason `shared_agent` until acknowledged on a shared agent. */
export function useGrantBrowserAccount() {
  return useAccountMutation(({ agentSlug, accountId, sharedAgentAcknowledged }: { agentSlug: string; accountId: string; sharedAgentAcknowledged?: boolean }) =>
    send(`/api/agents/${encodeURIComponent(agentSlug)}/browser-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, ...(sharedAgentAcknowledged ? { sharedAgentAcknowledged } : {}) }),
    }))
}

export function useRevokeBrowserAccount() {
  return useAccountMutation(({ agentSlug, accountId }: { agentSlug: string; accountId: string }) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}/agents/${encodeURIComponent(agentSlug)}`, { method: 'DELETE' }))
}

export function useRenameBrowserAccount() {
  return useAccountMutation(({ accountId, label }: { accountId: string; label: string | null }) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }))
}

/** Forget an account's saved sessions: its next sign-in fills its values again. */
export function useForgetBrowserAccountSessions() {
  return useAccountMutation((accountId: string) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}/sessions`, { method: 'DELETE' }))
}

/** Ask agents to add an authenticator app at their next sign-in with the account, or take that back. */
export function useRequestSignInMethod() {
  return useAccountMutation(({ accountId, requested }: { accountId: string; requested: boolean }) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}/sign-in-method-request`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested }),
    }))
}

/** Remove the authenticator app from the vault: agents ask the user for its codes again. */
export function useRemoveAuthenticator() {
  return useAccountMutation((accountId: string) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}/authenticator`, { method: 'DELETE' }))
}

/** Remove a passkey from the vault: agents no longer sign in with it. */
export function useRemovePasskey() {
  return useAccountMutation(({ accountId, credentialId }: { accountId: string; credentialId: string }) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}/passkeys`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialId }),
    }))
}

export function useDeleteBrowserAccount() {
  return useAccountMutation((accountId: string) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }))
}
