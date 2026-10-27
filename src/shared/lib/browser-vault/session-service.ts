import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { agentBrowserAccounts, browserAccounts, browserAccountSessions } from '@shared/lib/db/schema'
import { openJson, sealJson, VaultSealError } from './vault-crypto'
import { sessionBundleSchema, type BrowserType, type SessionBundle } from './vault-schemas'
import type { VaultOwner } from './vault-service'

/**
 * Saved sessions: an account's cookies and web storage, one per browser type
 * (it restores only into the type it came from), sealed like its secrets.
 *
 * `version` is one sequence across every saved session, so a version names
 * one capture: a grant's `applied_session_version` says which capture its
 * agent's browser holds (it was restored there, or captured from there), and
 * the vault restores a session into a browser only when it holds another.
 * Of an agent's accounts on one site, only one can be in its browser: the
 * others' marks go when one is restored or captured.
 */

/** One row per account and browser type: its id says which, and the seal is bound to it. */
function sessionRowId(accountId: string, browserType: BrowserType): string {
  return `${accountId}:${browserType}`
}

/** The next capture's version: past every saved session's. */
function nextVersion(): SQL<number> {
  return sql<number>`(select coalesce(max(${browserAccountSessions.version}), 0) + 1 from ${browserAccountSessions})`
}

/** The statements that make `accountId` the account on `site` the agent's browser holds, at `version`. */
function holdStatements(agentSlug: string, accountId: string, site: string, version: number | SQL<number>) {
  const sameSite = db.select({ id: browserAccounts.id }).from(browserAccounts).where(eq(browserAccounts.site, site))
  return [
    db.update(agentBrowserAccounts)
      .set({ appliedSessionVersion: version })
      .where(and(eq(agentBrowserAccounts.agentSlug, agentSlug), eq(agentBrowserAccounts.accountId, accountId))),
    db.update(agentBrowserAccounts)
      .set({ appliedSessionVersion: null })
      .where(and(
        eq(agentBrowserAccounts.agentSlug, agentSlug),
        ne(agentBrowserAccounts.accountId, accountId),
        inArray(agentBrowserAccounts.accountId, sameSite),
      )),
  ] as const
}

/**
 * Save a capture from the agent's browser as the account's session for its
 * browser type, over the one before: the newest sign-in is what restores.
 * The agent's browser holds it from now on.
 */
export async function saveAccountSession(input: {
  agentSlug: string
  account: { id: string; site: string }
  browserType: BrowserType
  bundle: SessionBundle
}): Promise<void> {
  const { agentSlug, account, browserType, bundle } = input
  const id = sessionRowId(account.id, browserType)
  const sealed = sealJson(bundle, { purpose: 'account-session', id, site: account.site }, sessionBundleSchema)
  const now = new Date()
  const committed = sql<number>`(select ${browserAccountSessions.version} from ${browserAccountSessions} where ${browserAccountSessions.id} = ${id})`
  await batch([
    db.insert(browserAccountSessions)
      .values({ id, accountId: account.id, browserType, bundle: sealed, version: nextVersion(), capturedAt: now, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: browserAccountSessions.id, set: { bundle: sealed, version: nextVersion(), capturedAt: now, updatedAt: now } }),
    ...holdStatements(agentSlug, account.id, account.site, committed),
  ])
}

export interface SavedSession {
  version: number
  capturedAt: Date
  bundle: SessionBundle
}

/** The account's saved session for this browser type; null when it has none, or its seal does not open here. */
export async function readAccountSession(account: { id: string; site: string }, browserType: BrowserType): Promise<SavedSession | null> {
  const id = sessionRowId(account.id, browserType)
  const row = await db.select().from(browserAccountSessions).where(eq(browserAccountSessions.id, id)).get()
  if (!row) return null
  try {
    const bundle = openJson(row.bundle, { purpose: 'account-session', id, site: account.site }, sessionBundleSchema)
    return { version: row.version, capturedAt: row.capturedAt, bundle }
  } catch (error) {
    if (!(error instanceof VaultSealError)) throw error
    // Sealed under another key, or damaged: the next sign-in saves a new one over it.
    console.error(`[browser-vault] The saved session of account ${account.id} could not be read: ${error.message}`)
    return null
  }
}

/** Which capture of the account's session the agent's browser holds, if any. */
export async function heldSessionVersion(agentSlug: string, accountId: string): Promise<number | null> {
  const row = await db.select({ version: agentBrowserAccounts.appliedSessionVersion })
    .from(agentBrowserAccounts)
    .where(and(eq(agentBrowserAccounts.agentSlug, agentSlug), eq(agentBrowserAccounts.accountId, accountId)))
    .get()
  return row?.version ?? null
}

/** The account on `site` whose session the agent's browser holds, and which capture: at most one. */
export async function heldAccountOnSite(agentSlug: string, site: string): Promise<{ accountId: string; version: number } | null> {
  const row = await db.select({ accountId: agentBrowserAccounts.accountId, version: agentBrowserAccounts.appliedSessionVersion })
    .from(agentBrowserAccounts)
    .innerJoin(browserAccounts, eq(browserAccounts.id, agentBrowserAccounts.accountId))
    .where(and(eq(agentBrowserAccounts.agentSlug, agentSlug), eq(browserAccounts.site, site), isNotNull(agentBrowserAccounts.appliedSessionVersion)))
    .get()
  return row?.version != null ? { accountId: row.accountId, version: row.version } : null
}

/** The account's session at `version` was restored into the agent's browser: in place of any other account's on the site. */
export async function markSessionHeld(input: { agentSlug: string; account: { id: string; site: string }; version: number }): Promise<void> {
  await batch([...holdStatements(input.agentSlug, input.account.id, input.account.site, input.version)])
}

/** The saved sessions of these accounts, for the owner's list: which browser types, and when. Never a bundle. */
export async function listAccountSessions(accountIds: string[]): Promise<Array<{ accountId: string; browserType: BrowserType; capturedAt: Date }>> {
  if (accountIds.length === 0) return []
  return db.select({
    accountId: browserAccountSessions.accountId,
    browserType: browserAccountSessions.browserType,
    capturedAt: browserAccountSessions.capturedAt,
  })
    .from(browserAccountSessions)
    .where(inArray(browserAccountSessions.accountId, accountIds))
    .orderBy(asc(browserAccountSessions.browserType))
    .all()
}

/**
 * Forget an owned account's saved sessions: the next sign-in with it fills
 * its values (and saves a new one). The agents' browsers stay as they are.
 * False when the account is not the owner's.
 */
export async function forgetAccountSessions(owner: VaultOwner, accountId: string): Promise<boolean> {
  const owned = await db.select({ id: browserAccounts.id }).from(browserAccounts)
    .where(and(eq(browserAccounts.id, accountId), owner === null ? undefined : eq(browserAccounts.userId, owner)))
    .get()
  if (!owned) return false
  await batch([
    db.delete(browserAccountSessions).where(eq(browserAccountSessions.accountId, accountId)),
    // No browser holds a capture that is gone: and its version may be the next one given out.
    db.update(agentBrowserAccounts).set({ appliedSessionVersion: null }).where(eq(agentBrowserAccounts.accountId, accountId)),
  ])
  return true
}
