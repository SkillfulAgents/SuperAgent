import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import { providerName } from '@shared/lib/browser-vault/providers'
import { stopSessionWatches } from '@shared/lib/browser-vault/session-host'
import { forgetAccountSessions, listAccountSessions } from '@shared/lib/browser-vault/session-service'
import type { BrowserType } from '@shared/lib/browser-vault/vault-schemas'
import {
  deleteAccount,
  getOwnedAccount,
  grantAccount,
  listAccountAgentSlugs,
  listOwnedAccounts,
  renameAccount,
  revokeAccount,
  type VaultAccount,
} from '@shared/lib/browser-vault/vault-service'
import { countOtherMembers } from '@shared/lib/services/agent-members-service'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { AgentUser, Authenticated, getAgentId } from '../middleware/auth'

/**
 * The Browser Vault in settings: the caller's saved accounts (metadata only,
 * never a value), which agents may use each one, rename and delete. In auth
 * mode every user sees and manages only their own vault.
 */
const browserAccounts = new Hono()
browserAccounts.use('*', Authenticated())

function accountDto(
  account: VaultAccount,
  agents?: Array<{ slug: string; name: string }>,
  sessions?: Array<{ browserType: BrowserType; capturedAt: Date }>,
) {
  return {
    id: account.id,
    site: account.site,
    username: account.username,
    label: account.label,
    origin: account.origin,
    parts: account.parts,
    via: account.via ? { ...account.via, providerName: providerName(account.via.site) } : null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    rejectedAt: account.rejectedAt?.toISOString() ?? null,
    ...(agents ? { agentSlugs: agents.map((agent) => agent.slug), agents } : {}),
    // Which browser types hold a saved session of it, and since when: never the session.
    ...(sessions ? { sessions: sessions.map((session) => ({ browserType: session.browserType, capturedAt: session.capturedAt.toISOString() })) } : {}),
  }
}

const renameBodySchema = z.object({ label: z.string().trim().max(200).nullable() }).strict()

// GET /api/browser-accounts - The caller's saved accounts, with the agents that may use each
browserAccounts.get('/', async (c) => {
  c.header('Cache-Control', 'no-store')
  const accounts = await listOwnedAccounts(getViewerUserId(c))
  const sessions = await listAccountSessions(accounts.map((account) => account.id))
  return c.json({
    accounts: accounts.map((account) => accountDto(account, account.agents, sessions.filter((session) => session.accountId === account.id))),
  })
})

// GET /api/browser-accounts/:id/agents - The agents that may sign in with an account
browserAccounts.get('/:id/agents', async (c) => {
  const account = await getOwnedAccount(getViewerUserId(c), c.req.param('id'))
  if (!account) return c.json({ error: 'Saved account not found' }, 404)
  return c.json({ agentSlugs: await listAccountAgentSlugs(account.id) })
})

// PATCH /api/browser-accounts/:id - Rename (a null label shows the username)
browserAccounts.patch('/:id', zValidator('json', renameBodySchema), async (c) => {
  const viewer = getViewerUserId(c)
  const id = c.req.param('id')
  if (!(await renameAccount(viewer, id, c.req.valid('json').label))) return c.json({ error: 'Saved account not found' }, 404)
  await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: id, action: 'updated', details: { renamed: true } })
  return c.json({ success: true })
})

// DELETE /api/browser-accounts/:id - Delete an account; its grants go with it
browserAccounts.delete('/:id', async (c) => {
  const viewer = getViewerUserId(c)
  const id = c.req.param('id')
  const deleted = await deleteAccount(viewer, id)
  if (!deleted) return c.json({ error: 'Saved account not found' }, 404)
  stopSessionWatches(id)
  await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: id, action: 'deleted', details: { agentSlugs: deleted.agentSlugs } })
  return c.json({ success: true })
})

// DELETE /api/browser-accounts/:id/sessions - Forget an account's saved sessions: the
// next sign-in with it fills its values. Agents' browsers stay signed in as they are.
browserAccounts.delete('/:id/sessions', async (c) => {
  const viewer = getViewerUserId(c)
  const id = c.req.param('id')
  if (!(await forgetAccountSessions(viewer, id))) return c.json({ error: 'Saved account not found' }, 404)
  stopSessionWatches(id)
  await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: id, action: 'updated', details: { sessionsForgotten: true } })
  return c.json({ success: true })
})

// DELETE /api/browser-accounts/:id/agents/:agentSlug - Stop an agent using an account.
// The owner can always revoke, whatever their role on the agent now.
browserAccounts.delete('/:id/agents/:agentSlug', async (c) => {
  const viewer = getViewerUserId(c)
  const id = c.req.param('id')
  const agentSlug = c.req.param('agentSlug')
  if (!(await revokeAccount({ owner: viewer, accountId: id, agentSlug }))) return c.json({ error: 'Grant not found' }, 404)
  stopSessionWatches(id, agentSlug)
  await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: id, action: 'unassigned', details: { agentSlug } })
  return c.json({ success: true })
})

export default browserAccounts

/**
 * Granting an account to an agent other people can use lets them sign in
 * as its owner: only once the user saw that. Null when it may go ahead.
 */
export async function sharedAgentRefusal(c: Context, agentSlug: string, acknowledged: boolean | undefined): Promise<Response | null> {
  if (acknowledged || !isAuthMode()) return null
  if (await countOtherMembers(agentSlug, getViewerUserId(c)) === 0) return null
  return c.json({ error: 'Other people who can use this agent could sign in with this account. Confirm before you share it.', reason: 'shared_agent' }, 409)
}

const grantBodySchema = z.object({
  accountId: z.string().min(1).max(64),
  sharedAgentAcknowledged: z.boolean().optional(),
}).strict()

/** Agent-scoped vault routes, mounted under /api/agents. */
export const agentBrowserAccountRoutes = new Hono()

// POST /api/agents/:id/browser-accounts - Let the agent sign in with one of the caller's accounts
agentBrowserAccountRoutes.post('/:id/browser-accounts', AgentUser(), zValidator('json', grantBodySchema), async (c) => {
  const viewer = getViewerUserId(c)
  const agentSlug = getAgentId(c)
  const body = c.req.valid('json')
  const account = await getOwnedAccount(viewer, body.accountId)
  if (!account) return c.json({ error: 'Saved account not found' }, 404)
  const refused = await sharedAgentRefusal(c, agentSlug, body.sharedAgentAcknowledged)
  if (refused) return refused
  if (await grantAccount({ accountId: account.id, agentSlug, grantedBy: viewer })) {
    await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: account.id, action: 'assigned', details: { agentSlug } })
  }
  return c.json({ success: true })
})
