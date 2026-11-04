import { app, safeStorage } from 'electron'
import { getDataDir } from '@shared/lib/config/data-dir'
import { appKeyProbes } from '@shared/lib/keys/app-key-probes'
import { installKeyManager, isKeyManagerInstalled, keyManager } from '@shared/lib/keys/key-manager'
import { DesktopKeyManager } from './desktop-key-manager'

/**
 * Electron main's key-custody boot step, after `openDatabase()` and before
 * the API is bound: safeStorage is usable once the app is ready (Linux and
 * Windows need the `ready` event; on Linux the keyring backend is chosen then).
 */
export async function installDesktopKeyManager(): Promise<DesktopKeyManager> {
  await app.whenReady()
  const manager = new DesktopKeyManager({
    dataDir: getDataDir(),
    safeStorage,
    platform: process.platform,
    probes: appKeyProbes,
  })
  await installKeyManager(manager)
  return manager
}

/** The installed desktop manager, for main-process key operations (export); null before install. */
export function installedDesktopKeyManager(): DesktopKeyManager | null {
  if (!isKeyManagerInstalled()) return null
  const manager = keyManager()
  return manager instanceof DesktopKeyManager ? manager : null
}
