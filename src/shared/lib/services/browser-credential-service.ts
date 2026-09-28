import crypto from 'crypto'
import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch, changesOf } from '@shared/lib/db/batch'
import {
  agentBrowserCredentials,
  agents,
  browserCredentials,
  type BrowserCredential,
} from '@shared/lib/db/schema'
import { decryptBrowserBundle, encryptBrowserBundle } from '@shared/lib/browser/browser-vault-crypto'
import type { SiteStorageBundle } from '../../../../agent-container/src/browser-storage-bundle'

function ownedBy(userId: string | null) {
  return userId === null ? undefined : eq(browserCredentials.userId, userId)
}

export interface SaveBrowserLoginInput {
  /** Acting user in auth mode, null in non-auth mode (see getViewerUserId). */
  userId: string | null
  agentSlug: string
  browserType: BrowserCredential['browserType']
  bundle: SiteStorageBundle
}

export interface SaveBrowserLoginResult {
  status: 'created' | 'updated'
  credentialId: string
  version: number
}

/**
 * Save a captured login as the user's one login for `bundle.site` in this
 * browser type: overwrite it (bumping `version`) or create it. Either way the
 * agent is mapped to it, replacing its previous login for the site.
 */
export async function saveBrowserLogin(input: SaveBrowserLoginInput): Promise<SaveBrowserLoginResult> {
  const { userId, agentSlug, browserType, bundle } = input
  const site = bundle.site
  const now = new Date()

  const existing = await db
    .select({ id: browserCredentials.id, version: browserCredentials.version })
    .from(browserCredentials)
    .where(and(
      eq(browserCredentials.site, site),
      eq(browserCredentials.browserType, browserType),
      ownedBy(userId),
    ))
    .get()

  const id = existing?.id ?? crypto.randomUUID()
  const version = existing ? existing.version + 1 : 1
  const encrypted = encryptBrowserBundle(bundle, { id, site })
  await batch([
    existing
      ? db.update(browserCredentials)
        .set({ bundle: encrypted, version, capturedAt: now, updatedAt: now })
        .where(eq(browserCredentials.id, id))
      : db.insert(browserCredentials).values({
        id,
        userId,
        name: site,
        site,
        browserType,
        bundle: encrypted,
        version,
        capturedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    db.insert(agentBrowserCredentials)
      .values({ agentSlug, credentialId: id, site, appliedVersion: version, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentBrowserCredentials.agentSlug, agentBrowserCredentials.site],
        set: { credentialId: id, appliedVersion: version, updatedAt: now },
      }),
  ])
  return { status: existing ? 'updated' : 'created', credentialId: id, version }
}

/** Saved logins the user can offer for `site` in a browser of `browserType`; metadata only. */
export async function listBrowserLogins(input: {
  userId: string | null
  site: string
  browserType: BrowserCredential['browserType']
}): Promise<Array<Pick<BrowserCredential, 'id' | 'name' | 'site' | 'capturedAt'>>> {
  return db
    .select({
      id: browserCredentials.id,
      name: browserCredentials.name,
      site: browserCredentials.site,
      capturedAt: browserCredentials.capturedAt,
    })
    .from(browserCredentials)
    .where(and(
      eq(browserCredentials.site, input.site),
      eq(browserCredentials.browserType, input.browserType),
      ownedBy(input.userId),
    ))
    .orderBy(desc(browserCredentials.capturedAt))
    .all()
}

export async function getOwnedBrowserLogin(userId: string | null, id: string): Promise<BrowserCredential | undefined> {
  return db
    .select()
    .from(browserCredentials)
    .where(and(eq(browserCredentials.id, id), ownedBy(userId)))
    .get()
}

/** Record that the agent's browser now holds `version` of the credential, replacing its previous login for the site. */
export async function mapAgentToBrowserLogin(input: {
  agentSlug: string
  credentialId: string
  site: string
  version: number
}): Promise<void> {
  const now = new Date()
  await db.insert(agentBrowserCredentials)
    .values({
      agentSlug: input.agentSlug,
      credentialId: input.credentialId,
      site: input.site,
      appliedVersion: input.version,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentBrowserCredentials.agentSlug, agentBrowserCredentials.site],
      set: { credentialId: input.credentialId, appliedVersion: input.version, updatedAt: now },
    })
    .run()
}

/** Origins to clear when signing agents out; a bundle that no longer decrypts must not block deletion. */
function storedOrigins(credential: BrowserCredential): string[] {
  try {
    return decryptBrowserBundle(credential.bundle, credential).origins.map((entry) => entry.origin)
  } catch (error) {
    console.error('[browser-vault] Could not decrypt saved login:', error instanceof Error ? error.message : 'unknown error')
    return []
  }
}

export interface ManagedBrowserLogin {
  id: string
  name: string
  site: string
  browserType: BrowserCredential['browserType']
  version: number
  capturedAt: Date
  agents: Array<{ slug: string; name: string }>
}

/** The caller's saved logins with the agents using each; metadata only. */
export async function listManagedBrowserLogins(userId: string | null): Promise<ManagedBrowserLogin[]> {
  const credentials = await db
    .select({
      id: browserCredentials.id,
      name: browserCredentials.name,
      site: browserCredentials.site,
      browserType: browserCredentials.browserType,
      version: browserCredentials.version,
      capturedAt: browserCredentials.capturedAt,
    })
    .from(browserCredentials)
    .where(ownedBy(userId))
    .orderBy(browserCredentials.site, desc(browserCredentials.capturedAt))
    .all()
  if (credentials.length === 0) return []

  const mappings = await db
    .select({
      credentialId: agentBrowserCredentials.credentialId,
      slug: agentBrowserCredentials.agentSlug,
      name: agents.name,
    })
    .from(agentBrowserCredentials)
    .leftJoin(agents, eq(agents.slug, agentBrowserCredentials.agentSlug))
    .where(inArray(agentBrowserCredentials.credentialId, credentials.map((credential) => credential.id)))
    .all()

  return credentials.map((credential) => ({
    ...credential,
    agents: mappings
      .filter((mapping) => mapping.credentialId === credential.id)
      .map((mapping) => ({ slug: mapping.slug, name: mapping.name ?? mapping.slug })),
  }))
}

export async function renameBrowserLogin(userId: string | null, id: string, name: string): Promise<boolean> {
  const result = await db
    .update(browserCredentials)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(browserCredentials.id, id), ownedBy(userId)))
    .run()
  return changesOf(result) > 0
}

/** Delete an owned credential (its agent mappings cascade). Returns the agents that were using it. */
export async function deleteBrowserLogin(
  userId: string | null,
  id: string,
): Promise<{ site: string; origins: string[]; agentSlugs: string[] } | null> {
  const credential = await getOwnedBrowserLogin(userId, id)
  if (!credential) return null
  const origins = storedOrigins(credential)
  const mapped = await db
    .select({ agentSlug: agentBrowserCredentials.agentSlug })
    .from(agentBrowserCredentials)
    .where(eq(agentBrowserCredentials.credentialId, id))
    .all()
  const result = await db.delete(browserCredentials).where(and(eq(browserCredentials.id, id), ownedBy(userId))).run()
  if (changesOf(result) === 0) return null
  return { site: credential.site, origins, agentSlugs: mapped.map((row) => row.agentSlug) }
}

/** Stop an agent using an owned credential. Returns the site and stored origins for clearing its browser. */
export async function unmapBrowserLogin(
  userId: string | null, id: string, agentSlug: string,
): Promise<{ site: string; origins: string[] } | null> {
  const credential = await getOwnedBrowserLogin(userId, id)
  if (!credential) return null
  const origins = storedOrigins(credential)
  const result = await db
    .delete(agentBrowserCredentials)
    .where(and(eq(agentBrowserCredentials.agentSlug, agentSlug), eq(agentBrowserCredentials.credentialId, id)))
    .run()
  return changesOf(result) > 0 ? { site: credential.site, origins } : null
}

/** Credentials mapped to the agent whose latest version is not yet in its browser. */
export async function listOutdatedAgentBrowserLogins(
  agentSlug: string,
  browserType: BrowserCredential['browserType'],
): Promise<BrowserCredential[]> {
  const rows = await db
    .select({ credential: browserCredentials })
    .from(agentBrowserCredentials)
    .innerJoin(browserCredentials, eq(browserCredentials.id, agentBrowserCredentials.credentialId))
    .where(and(
      eq(agentBrowserCredentials.agentSlug, agentSlug),
      eq(browserCredentials.browserType, browserType),
      gt(browserCredentials.version, agentBrowserCredentials.appliedVersion),
    ))
    .all()
  return rows.map((row) => row.credential)
}
