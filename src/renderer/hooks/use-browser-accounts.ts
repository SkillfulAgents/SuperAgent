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

export function useDeleteBrowserAccount() {
  return useAccountMutation((accountId: string) =>
    send(`/api/browser-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }))
}
