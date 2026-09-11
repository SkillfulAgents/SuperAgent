/**
 * `ConfigOps` for an agent whose workspace is a directory on this machine.
 *
 * Two things are local here. A document the container also writes (`.env`) is
 * serialized with the on-disk lock the container honours too, so an update
 * from either side re-reads fresh under the lock. And `.env` is kept at the
 * mode the container can read: an older build's atomic rename could leave it
 * owner-only, so a read heals the mode when this process owns the file.
 */
import fs from 'fs'
import path from 'path'
import { withCrossProcessFileLock } from '@shared/lib/utils/file-storage'
import { CONFIG_DOCS, configDocMode, type ConfigDocId } from './config-schema'
import { createConfigOps, inProcessSerializer } from './config-ops'
import type { ConfigOps, FileOps } from './types'

export interface LocalConfigOpsDeps {
  files: FileOps
  /** Where the workspace is on this machine; the lock file sits beside the document. */
  workspaceHostPath: () => string
}

export function createLocalConfigOps(deps: LocalConfigOpsDeps): ConfigOps {
  const inProcess = inProcessSerializer()
  const hostPathOf = (id: ConfigDocId) => path.join(deps.workspaceHostPath(), ...CONFIG_DOCS[id].path.split('/'))

  return createConfigOps(deps.files, {
    serialize: async (id, fn) => {
      if (!CONFIG_DOCS[id].shared) return inProcess(id, fn)
      // The lock file lives beside the document, so the directory has to exist.
      await deps.files.mkdir('')
      return withCrossProcessFileLock(hostPathOf(id), fn)
    },
    beforeGet: async (id) => {
      const mode = configDocMode(id)
      if (mode === undefined) return
      const hostPath = hostPathOf(id)
      try {
        const stat = await fs.promises.stat(hostPath)
        if ((stat.mode & 0o777) !== mode) {
          await fs.promises.chmod(hostPath, mode)
          console.warn(`[agent-actor] Healed ${hostPath} permissions back to ${mode.toString(8)}`)
        }
      } catch {
        // absent, or not ours to fix (chmod is owner-only) — the container heals its own
      }
    },
  })
}
