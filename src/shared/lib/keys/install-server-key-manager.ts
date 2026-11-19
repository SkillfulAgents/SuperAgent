import { getDataDir } from '@shared/lib/config/data-dir'
import { appKeyProbes } from './app-key-probes'
import { ensureKeyManager, type KeyManager } from './key-manager'
import { ServerKeyManager } from './server-key-manager'

/**
 * The web server's and the Vite dev server's boot step, after
 * `openDatabase()`: key custody from the deployment's settings (or the data
 * directory's key file). Safe to call again, or at once, from a dev server
 * that runs it per request.
 */
export function installServerKeyManager(): Promise<KeyManager> {
  return ensureKeyManager(() => new ServerKeyManager({ dataDir: getDataDir(), env: process.env, probes: appKeyProbes }))
}
