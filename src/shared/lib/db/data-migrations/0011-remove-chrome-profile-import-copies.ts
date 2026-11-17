/**
 * Remove what the retired Chrome profile import left on this machine.
 *
 * With a Chrome profile selected in Settings, every container start copied
 * that profile's cookies, saved passwords, autofill data and storage into the
 * agent's workspace, where the built-in browser never read them (see
 * `removeImportedChromeProfileCopies`). Those copies are deleted.
 *
 * The host browser copied the profile once, into the dedicated profile Chrome
 * then ran on, where it is mixed with everything the agent signed in to
 * since. That profile is kept, so no agent is signed out; only the sync's
 * manifest beside it goes. Re-running finds nothing left to delete.
 */
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { agents } from '../schema'
import { LOCAL_RUNTIME, removeImportedChromeProfileCopies } from '@shared/lib/agent-actor/agent-directories'
import { getDataDir } from '@shared/lib/config/data-dir'
import type { DataMigration, DataMigrationDb } from './index'

/** The host browser's profiles, one per agent (`ChromeProvider`). */
const HOST_BROWSER_PROFILES = 'host-browser-profiles'
const PROFILE_SYNC_MANIFEST = '.superagent-profile-sync.json'

/** Returns the slugs of the agents whose workspace had copies. */
export async function removeChromeProfileImportCopies(db: DataMigrationDb): Promise<string[]> {
  const rows = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.runtime, LOCAL_RUNTIME)).all()
  const cleaned: string[] = []
  for (const { slug } of rows) {
    try {
      if (await removeImportedChromeProfileCopies(slug)) cleaned.push(slug)
    } catch (error) {
      // Chrome never reads the copies, so leaving them changes nothing for the agent.
      console.warn(`Could not remove the imported Chrome profile copies of agent ${slug}:`, error)
    }
  }

  const hostProfiles = path.join(getDataDir(), HOST_BROWSER_PROFILES)
  const instances = await fs.promises.readdir(hostProfiles).catch(() => [])
  for (const instance of instances) {
    const manifest = path.join(hostProfiles, instance, 'Default', PROFILE_SYNC_MANIFEST)
    await fs.promises.rm(manifest, { force: true }).catch((error: unknown) => {
      console.warn(`Could not remove ${manifest}:`, error)
    })
  }
  return cleaned
}

export const removeChromeProfileImport: DataMigration = {
  id: 11,
  name: 'remove-chrome-profile-import-copies',
  async run(db) {
    await removeChromeProfileImportCopies(db)
  },
}
