import crypto from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { agentBrowserCredentials, browserCredentials, type BrowserCredential } from '@shared/lib/db/schema'
import { encryptBrowserBundle } from '@shared/lib/browser/browser-vault-crypto'
import type { SiteStorageBundle } from '../../../../agent-container/src/browser-storage-bundle'

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
    .select({ id: browserCredentials.id })
    .from(browserCredentials)
    .where(and(
      eq(browserCredentials.site, site),
      eq(browserCredentials.browserType, browserType),
      userId === null ? undefined : eq(browserCredentials.userId, userId),
    ))
    .get()

  const id = existing?.id ?? crypto.randomUUID()
  const encrypted = encryptBrowserBundle(bundle, { id, site })
  // Concurrent saves each bump the version in SQL; the mapping reads the version its own batch committed.
  const committedVersion = sql<number>`(select ${browserCredentials.version} from ${browserCredentials} where ${browserCredentials.id} = ${id})`
  await batch([
    existing
      ? db.update(browserCredentials)
        .set({ bundle: encrypted, version: sql`${browserCredentials.version} + 1`, capturedAt: now, updatedAt: now })
        .where(eq(browserCredentials.id, id))
      : db.insert(browserCredentials).values({
        id,
        userId,
        name: site,
        site,
        browserType,
        bundle: encrypted,
        version: 1,
        capturedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    db.insert(agentBrowserCredentials)
      .values({ agentSlug, credentialId: id, site, appliedVersion: committedVersion, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentBrowserCredentials.agentSlug, agentBrowserCredentials.site],
        set: { credentialId: id, appliedVersion: committedVersion, updatedAt: now },
      }),
  ])
  return { status: existing ? 'updated' : 'created', credentialId: id }
}
