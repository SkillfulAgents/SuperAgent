import crypto from 'crypto'
import { and, asc, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { batch, changesOf } from '@shared/lib/db/batch'
import { agentBrowserAccounts, agents, auditLog, browserAccounts, type BrowserAccount } from '@shared/lib/db/schema'
import { KeyUnavailableError } from '@shared/lib/keys/key-manager'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { providerOf } from './providers'
import { registrableDomain, usernameKey } from './site'
import { openJson, sealJson, VaultSealError } from './vault-crypto'
import { accountPartsSchema, accountSecretsSchema, MAX_PARTS, signInMethodsSchema, type AccountSecrets, type SignInMethods, type TotpSeed } from './vault-schemas'

/**
 * The Browser Vault's accounts and grants. An account is an owner's identity
 * on a site — its site (the sign-in form's host) and username — with the
 * parts each sign-in step added, or a pointer to the account it signs in
 * with elsewhere. Grants decide which agents may use it. Everything here is
 * metadata except `readAccountValues`.
 */

/** The account owner: a user id in auth mode, null in non-auth mode. */
export type VaultOwner = string | null

export interface VaultAccountRef {
  id: string
  site: string
  username: string
  label: string | null
}

export interface VaultAccount extends VaultAccountRef {
  ownerId: string | null
  origin: string
  /** Part keys the account holds ('password', 'text:…'), never values. */
  parts: string[]
  /** The account it signs in with on another site. */
  via: VaultAccountRef | null
  /** An agent said the site rejected what the vault filled: the user is asked until they enter its password again. */
  rejectedAt: Date | null
  /** Its sign-in methods beyond the parts: the authenticator app the vault holds, the owner's request for one. */
  signInMethods: SignInMethods
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date | null
}

export class VaultConflictError extends Error {}

/** The longest username the vault keeps (what the container names to the agent). */
export const MAX_USERNAME = 320

/** Owner scope for reads: everyone's rows in non-auth mode, as the other owned tables do. */
function ownedBy(owner: VaultOwner): SQL | undefined {
  return owner === null ? undefined : eq(browserAccounts.userId, owner)
}

/** The exact owner, as the unique index sees it (NULL is one owner). */
function exactOwner(owner: VaultOwner): SQL {
  return sql`coalesce(${browserAccounts.userId}, '') = ${owner ?? ''}`
}

function partsOf(row: Pick<BrowserAccount, 'parts'>): string[] {
  try {
    const parsed = accountPartsSchema.safeParse(JSON.parse(row.parts))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function methodsOf(row: Pick<BrowserAccount, 'signInMethods'>): SignInMethods {
  try {
    const parsed = signInMethodsSchema.safeParse(JSON.parse(row.signInMethods))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function toAccount(row: BrowserAccount, via: BrowserAccount | null): VaultAccount {
  return {
    id: row.id,
    ownerId: row.userId,
    site: row.site,
    username: row.username,
    label: row.label,
    origin: row.origin,
    parts: partsOf(row),
    via: via ? { id: via.id, site: via.site, username: via.username, label: via.label } : null,
    rejectedAt: row.rejectedAt,
    signInMethods: methodsOf(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  }
}

async function selectAccounts(where: SQL | undefined, order: 'site' | 'recent' = 'site'): Promise<VaultAccount[]> {
  const viaAccounts = alias(browserAccounts, 'via_account')
  const rows = await db
    .select({ account: browserAccounts, via: viaAccounts })
    .from(browserAccounts)
    .leftJoin(viaAccounts, eq(viaAccounts.id, browserAccounts.viaAccountId))
    .where(where)
    .orderBy(...(order === 'site'
      ? [asc(browserAccounts.site), asc(browserAccounts.usernameKey)]
      : [desc(browserAccounts.lastUsedAt), desc(browserAccounts.updatedAt)]))
    .all()
  return rows.map((row) => toAccount(row.account, row.via))
}

/**
 * The vault's key cannot be had here (a locked keychain, a key missing on this
 * machine): nothing is filled or saved. A VaultConflictError, so every caller
 * that tells the user why a save did not happen tells them this, with what to
 * do; the KeyManager's message for logs stays in the log.
 */
export class VaultUnavailableError extends VaultConflictError {}

/** Seal or open under the vault's key, a key that cannot be had here becoming VaultUnavailableError. */
async function withVaultKey<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof KeyUnavailableError)) throw error
    console.error(`[browser-vault] The vault key is unavailable (${error.reason}): ${error.message}`)
    throw new VaultUnavailableError(error.userMessage)
  }
}

function sealSecrets(secrets: AccountSecrets, row: { id: string; site: string }): Promise<string> {
  return withVaultKey(() => sealJson(secrets, { purpose: 'account-secrets', id: row.id, site: row.site }, accountSecretsSchema))
}

/**
 * The sealed parts of an account; empty when it holds none, null when the
 * seal does not open (sealed under another key, or damaged). Rejects with
 * VaultUnavailableError when the vault's key cannot be had at all.
 */
async function openAccountSecrets(row: Pick<BrowserAccount, 'id' | 'site' | 'secrets'>): Promise<AccountSecrets | null> {
  const secrets = row.secrets
  if (!secrets) return { values: {} }
  try {
    return await withVaultKey(() => openJson(secrets, { purpose: 'account-secrets', id: row.id, site: row.site }, accountSecretsSchema))
  } catch (error) {
    if (!(error instanceof VaultSealError)) throw error
    console.error(`[browser-vault] The saved parts of account ${row.id} could not be read: ${error.message}`)
    return null
  }
}

/**
 * The sealed parts of an account, for filling: one whose seal does not open,
 * or a vault whose key cannot be had here, fills nothing, so the user is asked
 * (and told why when they save).
 */
export async function readAccountSecrets(row: Pick<BrowserAccount, 'id' | 'site' | 'secrets'>): Promise<AccountSecrets> {
  try {
    return (await openAccountSecrets(row)) ?? { values: {} }
  } catch (error) {
    if (error instanceof VaultUnavailableError) return { values: {} }
    throw error
  }
}

async function accountRow(id: string): Promise<BrowserAccount | null> {
  return (await db.select().from(browserAccounts).where(eq(browserAccounts.id, id)).get()) ?? null
}

/** An account's saved values by part key: what the host fills into a page. */
export async function readAccountValues(accountId: string): Promise<Record<string, string>> {
  const row = await accountRow(accountId)
  return row ? (await readAccountSecrets(row)).values : {}
}

/**
 * An account's saved values, and the seed of the authenticator app it holds
 * (null when it holds none, or an agent said the site rejected its codes).
 */
export async function readAccountFill(accountId: string): Promise<{ values: Record<string, string>; totp: TotpSeed | null }> {
  const row = await accountRow(accountId)
  if (!row) return { values: {}, totp: null }
  const secrets = await readAccountSecrets(row)
  const authenticator = methodsOf(row).authenticator
  return { values: secrets.values, totp: authenticator && !authenticator.rejectedAt ? secrets.totp ?? null : null }
}

// ── Agent side: what an agent may use ──────────────────────────────────────

/** The accounts on `site` granted to the agent, most recently used first. */
export async function listGrantedAccounts(agentSlug: string, site: string): Promise<VaultAccount[]> {
  const granted = db
    .select({ id: agentBrowserAccounts.accountId })
    .from(agentBrowserAccounts)
    .where(eq(agentBrowserAccounts.agentSlug, agentSlug))
  return selectAccounts(and(eq(browserAccounts.site, site), inArray(browserAccounts.id, granted)), 'recent')
}

/** The agent's granted account on `site` with this username, if any. */
export async function findGrantedAccount(agentSlug: string, site: string, username: string): Promise<VaultAccount | null> {
  const key = usernameKey(username)
  return (await listGrantedAccounts(agentSlug, site)).find((account) => usernameKey(account.username) === key) ?? null
}

/** An account by id, whoever owns it: for a caller that already checked the agent may use it. */
export async function getAccount(id: string): Promise<VaultAccount | null> {
  return (await selectAccounts(eq(browserAccounts.id, id)))[0] ?? null
}

/** Which of these accounts the agent may use. */
export async function listGrantedAccountIds(agentSlug: string, accountIds: string[]): Promise<string[]> {
  if (accountIds.length === 0) return []
  const rows = await db
    .select({ accountId: agentBrowserAccounts.accountId })
    .from(agentBrowserAccounts)
    .where(and(eq(agentBrowserAccounts.agentSlug, agentSlug), inArray(agentBrowserAccounts.accountId, accountIds)))
    .all()
  return rows.map((row) => row.accountId)
}

export async function isAccountGranted(agentSlug: string, accountId: string): Promise<boolean> {
  const row = await db
    .select({ accountId: agentBrowserAccounts.accountId })
    .from(agentBrowserAccounts)
    .where(and(eq(agentBrowserAccounts.agentSlug, agentSlug), eq(agentBrowserAccounts.accountId, accountId)))
    .get()
  return !!row
}

/**
 * An agent used an account: when, on both rows, and in the audit log, with
 * whether its password went into the page and who filled it (the vault by
 * itself, or the user's form), or that its saved session was restored
 * instead. Never the values.
 */
export async function recordAccountUse(input: {
  agentSlug: string
  accountId: string
  sessionId: string
  userId?: string | null
  password: boolean
  by: 'vault' | 'user'
  session?: true
  /** A code from the authenticator app the vault holds went in. */
  code?: true
}): Promise<void> {
  const now = new Date()
  await batch([
    db.update(browserAccounts).set({ lastUsedAt: now }).where(eq(browserAccounts.id, input.accountId)),
    db.update(agentBrowserAccounts)
      .set({ lastUsedAt: now })
      .where(and(eq(agentBrowserAccounts.agentSlug, input.agentSlug), eq(agentBrowserAccounts.accountId, input.accountId))),
  ])
  await logAuditEvent({
    userId: input.userId ?? null,
    object: 'browser_account',
    objectId: input.accountId,
    action: 'used',
    details: {
      agentSlug: input.agentSlug,
      sessionId: input.sessionId,
      password: input.password,
      by: input.by,
      ...(input.session ? { session: true } : {}),
      ...(input.code ? { code: true } : {}),
    },
  })
}

const usedDetailsSchema = z.object({ password: z.boolean().optional(), code: z.boolean().optional(), by: z.enum(['vault', 'user']).optional() }).loose()

/**
 * When the account's password (or a code from its authenticator app) went
 * into a page within the last `withinMs`, newest first, by any agent in any
 * session (the audit log), and whether the vault filled it without the user.
 */
export async function recentPasswordFills(accountId: string, withinMs: number, now = Date.now(), what: 'password' | 'code' = 'password'): Promise<Array<{ at: Date; unattended: boolean }>> {
  const rows = await db.select({ createdAt: auditLog.createdAt, details: auditLog.details })
    .from(auditLog)
    .where(and(
      eq(auditLog.object, 'browser_account'),
      eq(auditLog.objectId, accountId),
      eq(auditLog.action, 'used'),
      gte(auditLog.createdAt, new Date(now - withinMs)),
    ))
    .orderBy(desc(auditLog.createdAt))
    .all()
  return rows.flatMap((row) => {
    let parsed: unknown = null
    try {
      parsed = row.details ? JSON.parse(row.details) : null
    } catch {
      return []
    }
    const details = usedDetailsSchema.safeParse(parsed)
    return details.success && details.data[what] ? [{ at: row.createdAt, unattended: details.data.by === 'vault' }] : []
  })
}

/**
 * The agent said the site rejected the account (a wrong or changed password):
 * the vault stops filling it without the user until they enter its password
 * again, in any session. Only an account the agent may use.
 */
export async function markAccountRejected(input: { agentSlug: string; accountId: string; sessionId: string }): Promise<void> {
  const granted = db.select({ id: agentBrowserAccounts.accountId }).from(agentBrowserAccounts)
    .where(and(eq(agentBrowserAccounts.agentSlug, input.agentSlug), eq(agentBrowserAccounts.accountId, input.accountId)))
  const result = await db.update(browserAccounts).set({ rejectedAt: new Date() })
    .where(and(eq(browserAccounts.id, input.accountId), inArray(browserAccounts.id, granted)))
    .run()
  if (changesOf(result) === 0) return
  await logAuditEvent({
    userId: null,
    object: 'browser_account',
    objectId: input.accountId,
    action: 'rejected',
    details: { agentSlug: input.agentSlug, sessionId: input.sessionId },
  })
}

/** The user chose to use the account as it is saved: the vault fills it again. */
export async function clearAccountRejected(accountId: string): Promise<void> {
  await db.update(browserAccounts).set({ rejectedAt: null }).where(eq(browserAccounts.id, accountId)).run()
}

// ── Sign-in methods (part 4): an authenticator app the vault holds ─────────

/** `value` without `keys`. */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

/**
 * Change an account's `signInMethods`, and its sealed `secrets` when the
 * change gives them, with a compare-and-set on `revision`. False when the
 * account is gone or `change` leaves it as it is (null).
 */
async function updateSignInMethods(
  accountId: string,
  change: (methods: SignInMethods, row: BrowserAccount) => Promise<{ methods: SignInMethods; secrets?: string | null } | null>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await accountRow(accountId)
    if (!row) return false
    const next = await change(methodsOf(row), row)
    if (!next) return false
    const updated = await db.update(browserAccounts).set({
      signInMethods: JSON.stringify(signInMethodsSchema.parse(next.methods)),
      ...(next.secrets !== undefined ? { secrets: next.secrets } : {}),
      revision: row.revision + 1,
      updatedAt: new Date(),
    }).where(and(eq(browserAccounts.id, row.id), eq(browserAccounts.revision, row.revision))).run()
    if (changesOf(updated) > 0) return true
  }
  throw new VaultConflictError('The account kept changing while it was saved. Try again.')
}

/**
 * An agent added an authenticator app to the account on its site: the seed is
 * sealed with the account's other secrets (in place of an app it held
 * before), and the owner's request for one is answered. Only an account the
 * agent may use; one whose seal does not open here is left as it is, since
 * sealing anew would lose the parts it holds.
 */
export async function saveAuthenticator(input: {
  agentSlug: string
  accountId: string
  sessionId: string
  setup: { seed: TotpSeed; issuer: string | null; accountName: string | null }
  /** What the agent named it on the site, when the site asked. */
  name?: string | null
  /** Why the agent added it: the owner's standing request, or what the user said in the conversation. */
  asked: { request: true } | { words: string }
}): Promise<void> {
  if (!(await isAccountGranted(input.agentSlug, input.accountId))) throw new VaultConflictError('That saved account is no longer available to this agent')
  const saved = await updateSignInMethods(input.accountId, async (methods, row) => {
    const secrets = await openAccountSecrets(row)
    if (!secrets) throw new VaultConflictError('This saved account cannot be unlocked here, so nothing was added to it. Delete it in Settings → Logins and save it again.')
    const { issuer, accountName } = input.setup
    return {
      methods: { ...without(methods, 'requested', 'unavailable'), authenticator: { addedAt: Date.now(), issuer, accountName, name: input.name ?? null } },
      secrets: await sealSecrets({ ...secrets, totp: input.setup.seed }, row),
    }
  })
  if (!saved) throw new VaultConflictError('That saved account was not found')
  await logAuditEvent({
    userId: null,
    object: 'browser_account',
    objectId: input.accountId,
    action: 'method_added',
    details: {
      method: 'authenticator_app',
      agentSlug: input.agentSlug,
      sessionId: input.sessionId,
      ...('words' in input.asked ? { askedInChat: input.asked.words.slice(0, 300) } : { asked: 'request' }),
    },
  })
}

/**
 * An agent said the site rejected a code the vault's authenticator app made:
 * its codes are not filled without the user until an app is added again.
 * Only an account the agent may use.
 */
export async function markAuthenticatorRejected(input: { agentSlug: string; accountId: string; sessionId: string }): Promise<void> {
  if (!(await isAccountGranted(input.agentSlug, input.accountId))) return
  const marked = await updateSignInMethods(input.accountId, async (methods) => (
    methods.authenticator && !methods.authenticator.rejectedAt
      ? { methods: { ...methods, authenticator: { ...methods.authenticator, rejectedAt: Date.now() } } }
      : null
  ))
  if (!marked) return
  await logAuditEvent({
    userId: null,
    object: 'browser_account',
    objectId: input.accountId,
    action: 'rejected',
    details: { agentSlug: input.agentSlug, sessionId: input.sessionId, method: 'authenticator_app' },
  })
}

/**
 * An agent found no sign-in method it may add on the site (two-step
 * verification is off there, or adding one would replace another): the
 * owner's request is answered with why, in the agent's words. Only an account
 * the agent may use.
 */
export async function markSignInMethodUnavailable(input: { agentSlug: string; accountId: string; reason: string }): Promise<boolean> {
  if (!(await isAccountGranted(input.agentSlug, input.accountId))) return false
  return updateSignInMethods(input.accountId, async (methods) => ({
    methods: { ...without(methods, 'requested'), unavailable: { at: Date.now(), reason: input.reason.trim().slice(0, 500) } },
  }))
}

// ── Owner side: the vault itself ───────────────────────────────────────────

export async function getOwnedAccount(owner: VaultOwner, id: string): Promise<VaultAccount | null> {
  return (await selectAccounts(and(eq(browserAccounts.id, id), ownedBy(owner))))[0] ?? null
}

/** The owner's accounts on a site. */
export async function listOwnedAccountsOnSite(owner: VaultOwner, site: string): Promise<VaultAccount[]> {
  return selectAccounts(and(eq(browserAccounts.site, site), ownedBy(owner)), 'recent')
}

/**
 * The owner's accounts on other sites, for "Or sign in with Google, …" on the sign-in form:
 * any site can be someone's sign-in provider (a company's SSO), the well-known
 * ones first. Not the site's own domain (accounts.google.com on google.com's
 * page), and not an account that itself signs in elsewhere.
 */
export async function listOwnedAccountsElsewhere(owner: VaultOwner, site: string): Promise<VaultAccount[]> {
  const domain = registrableDomain(site)
  const accounts = (await selectAccounts(ownedBy(owner), 'recent'))
    .filter((account) => !account.via && registrableDomain(account.site) !== domain)
  const known = (account: VaultAccount) => providerOf(account.site) !== null
  return [...accounts.filter(known), ...accounts.filter((account) => !known(account))].slice(0, 30)
}

/**
 * The owner's account with this username at a sign-in provider, on whichever
 * of its sites it was saved ("Sign in with Google" names the account; its
 * password is saved on accounts.google.com).
 */
export async function findOwnedProviderAccount(owner: VaultOwner, providerSite: string, username: string): Promise<VaultAccount | null> {
  const key = usernameKey(username)
  const accounts = await selectAccounts(and(ownedBy(owner), eq(browserAccounts.usernameKey, key)), 'recent')
  return accounts.find((account) => !account.via && registrableDomain(account.site) === providerSite) ?? null
}

export interface ManagedAccount extends VaultAccount {
  agentSlugs: string[]
  /** The agents granted it, named: the owner may no longer be able to see some of them otherwise. */
  agents: Array<{ slug: string; name: string }>
}

/** Every account the owner has, with the agents granted each one. */
export async function listOwnedAccounts(owner: VaultOwner): Promise<ManagedAccount[]> {
  const accounts = await selectAccounts(ownedBy(owner))
  if (accounts.length === 0) return []
  const grants = await db
    .select({ accountId: agentBrowserAccounts.accountId, slug: agentBrowserAccounts.agentSlug, name: agents.name })
    .from(agentBrowserAccounts)
    .innerJoin(agents, eq(agents.slug, agentBrowserAccounts.agentSlug))
    .where(inArray(agentBrowserAccounts.accountId, accounts.map((account) => account.id)))
    .orderBy(asc(agentBrowserAccounts.createdAt))
    .all()
  return accounts.map((account) => {
    const granted = grants.filter((grant) => grant.accountId === account.id).map(({ slug, name }) => ({ slug, name }))
    return { ...account, agentSlugs: granted.map((agent) => agent.slug), agents: granted }
  })
}

export async function listAccountAgentSlugs(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ agentSlug: agentBrowserAccounts.agentSlug })
    .from(agentBrowserAccounts)
    .innerJoin(agents, eq(agents.slug, agentBrowserAccounts.agentSlug))
    .where(eq(agentBrowserAccounts.accountId, accountId))
    .orderBy(asc(agentBrowserAccounts.createdAt))
    .all()
  return rows.map((row) => row.agentSlug)
}

export interface SaveAccountInput {
  owner: VaultOwner
  site: string
  /** The origin the parts were entered for; kept from the first save. */
  origin: string
  username: string
  /** Parts to add or replace, by part key. */
  values?: Record<string, string>
  /** The provider account it signs in with; must be the same owner's. */
  viaAccountId?: string
}

/** The part keys of a row's `parts` column, checked before it is written. */
function partsColumn(parts: string[]): string {
  if (parts.length > MAX_PARTS) throw new VaultConflictError('Too many parts for one account')
  return JSON.stringify(accountPartsSchema.parse(parts))
}

/**
 * A provider account "Sign in with Google" saved by name only, on the
 * provider's domain (google.com): its password, once typed, is saved on the
 * site its sign-in form is on (accounts.google.com), into that same account.
 */
async function providerStub(owner: VaultOwner, key: string, site: string): Promise<BrowserAccount | null> {
  const provider = providerOf(site)
  if (!provider || provider.site === site) return null
  return (await db.select().from(browserAccounts).where(and(
    exactOwner(owner),
    eq(browserAccounts.site, provider.site),
    eq(browserAccounts.usernameKey, key),
    eq(browserAccounts.parts, '[]'),
    isNull(browserAccounts.viaAccountId),
  )).get()) ?? null
}

/**
 * Add parts to the owner's account on a site, creating it on the first save.
 * A sign-in split over steps lands in one account: each step's parts are
 * merged into what is there. Written with a compare-and-set on `revision`,
 * so two saves at once both land. Saving the password again is the user's
 * correction: the account fills without them again (`rejectedAt`), and with
 * its password rather than through a provider (`via`).
 */
export async function saveAccount(input: SaveAccountInput): Promise<{ account: VaultAccount; created: boolean }> {
  const username = input.username.trim()
  if (!username) throw new VaultConflictError('An account needs a username')
  if (username.length > MAX_USERNAME) throw new VaultConflictError('That username is too long to save')
  const key = usernameKey(username)
  const values = input.values ?? {}
  const changedValues = Object.keys(values).length > 0
  if (input.viaAccountId) {
    const via = await accountRow(input.viaAccountId)
    if (!via || (via.userId ?? '') !== (input.owner ?? '')) throw new VaultConflictError('The account it signs in with is not yours')
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const now = new Date()
    const existing = await db
      .select()
      .from(browserAccounts)
      .where(and(exactOwner(input.owner), eq(browserAccounts.site, input.site), eq(browserAccounts.usernameKey, key)))
      .get()
    if (!existing) {
      // Even the email step alone (no value yet): the password lands in the same account.
      const stub = input.viaAccountId ? null : await providerStub(input.owner, key, input.site)
      if (stub) {
        // Sealed before the write: the compare-and-set on `revision` still guards it.
        const stubSecrets = changedValues ? await sealSecrets({ values }, { id: stub.id, site: input.site }) : null
        const claimed = await db.update(browserAccounts).set({
          site: input.site,
          origin: input.origin,
          ...(stubSecrets
            ? {
                secrets: stubSecrets,
                parts: partsColumn(Object.keys(values).sort()),
              }
            : {}),
          revision: stub.revision + 1,
          updatedAt: now,
        }).where(and(eq(browserAccounts.id, stub.id), eq(browserAccounts.revision, stub.revision))).run()
        if (changesOf(claimed) > 0) return { account: (await getOwnedAccount(input.owner, stub.id))!, created: false }
        continue
      }
      const id = crypto.randomUUID()
      const newSecrets = changedValues ? await sealSecrets({ values }, { id, site: input.site }) : null
      const inserted = await db.insert(browserAccounts).values({
        id,
        userId: input.owner,
        site: input.site,
        username,
        usernameKey: key,
        origin: input.origin,
        viaAccountId: input.viaAccountId ?? null,
        secrets: newSecrets,
        parts: partsColumn(Object.keys(values).sort()),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run()
      if (changesOf(inserted) > 0) return { account: (await getOwnedAccount(input.owner, id))!, created: true }
      continue // saved by someone else meanwhile: merge into theirs
    }

    let sealed: { secrets: string; parts: string } | null = null
    if (changedValues) {
      // A seal that does not open (another key) is replaced only by values
      // for every part it lists: the rest would be lost for good. A vault
      // whose key cannot be had here saves nothing (VaultUnavailableError).
      const secrets = (await openAccountSecrets(existing)) ?? (partsOf(existing).every((part) => part in values) ? { values: {} } : null)
      if (!secrets) throw new VaultConflictError('This saved account cannot be unlocked here, so it was not changed. Delete it in Settings → Logins and save it again.')
      const merged = { ...secrets.values, ...values }
      sealed = {
        secrets: await sealSecrets({ ...secrets, values: merged }, existing),
        parts: partsColumn(Object.keys(merged).sort()),
      }
    }
    // The account's origin is where its password was last typed: the vault
    // fills it into plain HTTP without the user only when that was plain HTTP
    // too (vaultFillsInto). Other parts leave it as it is.
    const passwordFrom = 'password' in values && existing.origin !== input.origin ? input.origin : null
    const corrected = 'password' in values || (changedValues && !partsOf(existing).includes('password'))
    // A password the user saves is how the account signs in from now on, not
    // through a provider any more (as picking one drops the password).
    const via = input.viaAccountId ? { viaAccountId: input.viaAccountId } : 'password' in values ? { viaAccountId: null } : {}
    const updated = await db.update(browserAccounts).set({
      ...(sealed ?? {}),
      ...via,
      ...(passwordFrom ? { origin: passwordFrom } : {}),
      ...(corrected ? { rejectedAt: null } : {}),
      revision: existing.revision + 1,
      updatedAt: now,
    }).where(and(eq(browserAccounts.id, existing.id), eq(browserAccounts.revision, existing.revision))).run()
    if (changesOf(updated) > 0) return { account: (await getOwnedAccount(input.owner, existing.id))!, created: false }
  }
  throw new VaultConflictError('The account kept changing while it was saved. Try again.')
}

/**
 * The account signs in through another one from now on ("Sign in with
 * Google" picked for it): the password it held no longer applies, so the
 * vault stops filling it. Other parts (a workspace) stay.
 */
export async function switchAccountToVia(input: { owner: VaultOwner; accountId: string; viaAccountId: string }): Promise<VaultAccount> {
  const via = await accountRow(input.viaAccountId)
  if (!via || (via.userId ?? '') !== (input.owner ?? '')) throw new VaultConflictError('The account it signs in with is not yours')
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await accountRow(input.accountId)
    if (!existing || (existing.userId ?? '') !== (input.owner ?? '')) throw new VaultConflictError('That saved account was not found')
    const parts = partsOf(existing)
    let sealed: { secrets: string | null; parts: string } | null = null
    if (parts.includes('password')) {
      // The other parts are kept: a seal that does not open loses them unless
      // there are none. With only the password, nothing needs opening.
      const onlyPassword = parts.every((part) => part === 'password')
      const secrets = onlyPassword ? { values: {} } : await openAccountSecrets(existing)
      if (!secrets) throw new VaultConflictError('This saved account cannot be unlocked here, so it was not changed. Delete it in Settings → Logins and save it again.')
      const kept = Object.fromEntries(Object.entries(secrets.values).filter(([part]) => part !== 'password'))
      const keptParts = Object.keys(kept).sort()
      sealed = {
        secrets: keptParts.length ? await sealSecrets({ ...secrets, values: kept }, existing) : null,
        parts: partsColumn(keptParts),
      }
    }
    const updated = await db.update(browserAccounts).set({
      ...(sealed ?? {}),
      viaAccountId: input.viaAccountId,
      rejectedAt: null,
      revision: existing.revision + 1,
      updatedAt: new Date(),
    }).where(and(eq(browserAccounts.id, existing.id), eq(browserAccounts.revision, existing.revision))).run()
    if (changesOf(updated) > 0) return (await getOwnedAccount(input.owner, existing.id))!
  }
  throw new VaultConflictError('The account kept changing while it was saved. Try again.')
}

/** Grant an account to an agent. False when it already was. */
export async function grantAccount(input: { accountId: string; agentSlug: string; grantedBy: string | null }): Promise<boolean> {
  const result = await db.insert(agentBrowserAccounts).values({
    agentSlug: input.agentSlug,
    accountId: input.accountId,
    grantedBy: input.grantedBy,
    createdAt: new Date(),
  }).onConflictDoNothing().run()
  return changesOf(result) > 0
}

/** Revoke an owned account's grant. False when the account is not the owner's, or was not granted. */
export async function revokeAccount(input: { owner: VaultOwner; accountId: string; agentSlug: string }): Promise<boolean> {
  const owned = db.select({ id: browserAccounts.id }).from(browserAccounts).where(and(eq(browserAccounts.id, input.accountId), ownedBy(input.owner)))
  const result = await db.delete(agentBrowserAccounts).where(and(
    eq(agentBrowserAccounts.agentSlug, input.agentSlug),
    eq(agentBrowserAccounts.accountId, input.accountId),
    inArray(agentBrowserAccounts.accountId, owned),
  )).run()
  return changesOf(result) > 0
}

/**
 * Whether the agent in this session is yet to be asked for the sign-in method
 * the owner requested (method-request): true once, the first time for the
 * session, after which the request notes that session.
 */
export async function markSignInMethodAsked(accountId: string, sessionId: string): Promise<boolean> {
  return updateSignInMethods(accountId, async (methods) => (
    methods.requested && methods.requested.askedIn !== sessionId
      ? { methods: { ...methods, requested: { ...methods.requested, askedIn: sessionId } } }
      : null
  ))
}

/**
 * The owner asks agents to add a sign-in method to the account when one next
 * signs in with it (the sign-in card's box, or Settings → Logins), or takes
 * that back. Either way an earlier "none to add" answer goes.
 */
export async function setSignInMethodRequest(owner: VaultOwner, accountId: string, on: boolean, from: 'card' | 'logins'): Promise<boolean> {
  if (!(await getOwnedAccount(owner, accountId))) return false
  return updateSignInMethods(accountId, async (methods) => {
    const rest = without(methods, 'requested', 'unavailable')
    return { methods: on ? { ...rest, requested: { at: Date.now(), from } } : rest }
  })
}

/** The owner removed the account's authenticator app from the vault (the site still lists it). */
export async function removeAuthenticator(owner: VaultOwner, accountId: string): Promise<boolean> {
  if (!(await getOwnedAccount(owner, accountId))?.signInMethods.authenticator) return false
  const removed = await updateSignInMethods(accountId, async (methods, row) => {
    if (!methods.authenticator) return null
    const rest = without(methods, 'authenticator')
    const secrets = await openAccountSecrets(row)
    // Unreadable here: nothing in it can be used, and without its plain
    // record (which every use checks) neither can its seed.
    if (!secrets) return { methods: rest }
    const kept = without(secrets, 'totp')
    const empty = Object.keys(kept.values).length === 0 && !kept.passkeys?.length
    return { methods: rest, secrets: empty ? null : await sealSecrets(kept, row) }
  })
  if (removed) {
    await logAuditEvent({ userId: owner, object: 'browser_account', objectId: accountId, action: 'method_removed', details: { method: 'authenticator_app' } })
  }
  return removed
}

export async function renameAccount(owner: VaultOwner, id: string, label: string | null): Promise<boolean> {
  const result = await db.update(browserAccounts)
    .set({ label: label?.trim() || null, updatedAt: new Date(), revision: sql`${browserAccounts.revision} + 1` })
    .where(and(eq(browserAccounts.id, id), ownedBy(owner)))
    .run()
  return changesOf(result) > 0
}

/** Delete an owned account; its grants and saved sessions go with it. Returns the agents it was granted to. */
export async function deleteAccount(owner: VaultOwner, id: string): Promise<{ agentSlugs: string[] } | null> {
  const account = await getOwnedAccount(owner, id)
  if (!account) return null
  const agentSlugs = await listAccountAgentSlugs(id)
  const result = await db.delete(browserAccounts).where(and(eq(browserAccounts.id, id), ownedBy(owner))).run()
  return changesOf(result) > 0 ? { agentSlugs } : null
}
