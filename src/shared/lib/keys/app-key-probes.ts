import { probeVaultKey } from '@shared/lib/browser-vault/vault-key-probe'
import type { KeyProbes } from './key-manager'

/**
 * Each purpose's check of a candidate key against the data sealed under it,
 * as the entry points hand them to their KeyManager. They read the database:
 * a manager is installed after `openDatabase()`.
 */
export const appKeyProbes: KeyProbes = {
  'browser-vault': probeVaultKey,
}
