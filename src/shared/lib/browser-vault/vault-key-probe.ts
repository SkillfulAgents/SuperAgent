import type { KeyObject } from 'crypto'
import { desc, isNotNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { browserAccounts } from '@shared/lib/db/schema'
import type { KeyProbeResult } from '@shared/lib/keys/key-manager'
import { opensUnder } from './vault-crypto'

/** How many of the latest sealed values are tried: one damaged row is not a wrong key. */
const SAMPLE = 5

/**
 * What the vault's sealed data says about a candidate key, for the
 * KeyManager to check a key before it migrates, makes or uses one: 'opens'
 * when one of the latest sealed values opens under it, 'does-not-open' when
 * none does, 'nothing-sealed' on an empty vault. The latest values were
 * sealed under the key in use (every save seals again), so an older row
 * sealed under a key since lost does not read as a mismatch.
 */
export async function probeVaultKey(key: KeyObject): Promise<KeyProbeResult> {
  const rows = await db
    .select({ id: browserAccounts.id, site: browserAccounts.site, secrets: browserAccounts.secrets })
    .from(browserAccounts)
    .where(isNotNull(browserAccounts.secrets))
    .orderBy(desc(browserAccounts.updatedAt))
    .limit(SAMPLE)
    .all()
  if (rows.length === 0) return 'nothing-sealed'
  const opens = rows.some((row) => row.secrets !== null && opensUnder(row.secrets, { purpose: 'account-secrets', id: row.id, site: row.site }, key))
  return opens ? 'opens' : 'does-not-open'
}
