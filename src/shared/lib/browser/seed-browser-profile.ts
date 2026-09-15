/**
 * Seeding an agent's built-in browser from the Chrome profile selected in
 * settings, before its container starts. The profile is on this machine; the
 * destination is the agent's workspace, reached through its actor, so the
 * same code serves a workspace on this machine and one anywhere else.
 */
import { getSettings } from '@shared/lib/config/settings'
import {
  WorkspaceFileError,
  copyHostFileIntoWorkspace,
  joinWorkspacePath,
  workspaceDirname,
  type AgentActor,
  type FileOps,
} from '@shared/lib/agent-actor'
import { PROFILE_SYNC_MANIFEST, copyChromeProfileData, type ProfileSyncDestination } from './chrome-profile'

/** Where the container browser keeps its profile, relative to the workspace root. */
export const BROWSER_PROFILE_DIR = '.browser-profile'

/** A profile sync destination inside an agent's workspace. */
export function workspaceProfileDestination(files: FileOps, workspaceDir: string): ProfileSyncDestination {
  const at = (relativePath: string) => joinWorkspacePath(workspaceDir, relativePath)
  const manifestPath = at(PROFILE_SYNC_MANIFEST)
  return {
    readManifest: async () => {
      const bytes = await files.getDoc(manifestPath)
      return bytes === null ? null : new TextDecoder().decode(bytes)
    },
    // Host bookkeeping: the agent never reads it, so only this side needs to.
    writeManifest: (text) => files.putDoc(manifestPath, text, { mode: 0o600 }),
    hasFile: async (relativePath) => (await files.stat(at(relativePath)))?.kind === 'file',
    copyFile: async (sourcePath, relativePath) => {
      const destination = at(relativePath)
      await files.mkdir(workspaceDirname(destination))
      try {
        await copyHostFileIntoWorkspace(files, sourcePath, destination)
      } catch (error) {
        // The parent exists, so an absent path is the source: a transient
        // Chrome file that vanished after it was fingerprinted.
        if (!(error instanceof WorkspaceFileError && error.code === 'not-found')) throw error
      }
    },
  }
}

/**
 * Sync the selected Chrome profile into the agent's workspace. A host-browser
 * provider uses its own dedicated profile, so the copy is skipped for it;
 * with no profile selected there is nothing to do.
 */
export async function seedBrowserProfileFromChrome(actor: Pick<AgentActor, 'slug' | 'files'>): Promise<void> {
  const settings = getSettings()
  const chromeProfileId = settings.app?.chromeProfileId
  if (!chromeProfileId || settings.app?.hostBrowserProvider) return
  if (await copyChromeProfileData(chromeProfileId, workspaceProfileDestination(actor.files, BROWSER_PROFILE_DIR))) {
    console.log(`[BrowserProfile] Synchronized Chrome profile "${chromeProfileId}" into the workspace of ${actor.slug}`)
  }
}
