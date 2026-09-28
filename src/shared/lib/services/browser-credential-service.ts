import crypto from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { agentBrowserCredentials, browserCredentials, type BrowserCredential } from '@shared/lib/db/schema'
import { encryptBrowserBundle } from '@shared/lib/browser/browser-vault-crypto'
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
