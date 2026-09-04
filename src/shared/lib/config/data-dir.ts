import path from 'path'
import fs from 'fs'
import os from 'os'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'

/**
 * Get the data directory for Superagent.
 *
 * The data directory contains:
 * - The SQLite database (superagent.db)
 * - Agent workspace directories (agents/{agentId}/workspace)
 *
 * Can be configured via the SUPERAGENT_DATA_DIR environment variable.
 * Defaults to ~/.superagent/
 */
export function getDataDir(): string {
  const envDataDir = process.env.SUPERAGENT_DATA_DIR
  if (envDataDir) {
    return path.resolve(envDataDir)
  }
  return path.join(os.homedir(), '.superagent')
}

/**
 * Get the path to the SQLite database file.
 * SUPERAGENT_DB_PATH overrides the default ($SUPERAGENT_DATA_DIR/superagent.db).
 */
export function getDatabasePath(): string {
  const envDbPath = process.env.SUPERAGENT_DB_PATH
  if (envDbPath) {
    return path.resolve(envDbPath)
  }
  return path.join(getDataDir(), 'superagent.db')
}

/**
 * Regenerable cache directory (skillset zip unpack, etc.).
 * SUPERAGENT_CACHE_DIR overrides the default ($SUPERAGENT_DATA_DIR/skillset-cache).
 * Desktop is unchanged when the env is unset.
 */
export function getCacheDir(): string {
  const envCacheDir = process.env.SUPERAGENT_CACHE_DIR
  if (envCacheDir) {
    return path.resolve(envCacheDir)
  }
  return path.join(getDataDir(), 'skillset-cache')
}

/**
 * Get the path to the agents data directory.
 * This is where agent workspaces are stored.
 */
export function getAgentsDataDir(): string {
  return path.join(getDataDir(), 'agents')
}

/**
 * Top-level shared volumes directory ($DATA_DIR/volumes).
 * Sibling of agents/ — agent delete cannot reach it.
 */
export function getVolumesDataDir(): string {
  return path.join(getDataDir(), 'volumes')
}

/**
 * Directory for one shared volume, named by its opaque id.
 */
export function getVolumeDir(id: string): string {
  return path.join(getVolumesDataDir(), id)
}

/**
 * Where a host path lives on the shared org disk, as a path relative to the
 * disk root, or null when the runtime cannot mount it.
 *
 * The host app and every cloud agent mount the same disk, and the host app's
 * data dir is that disk's root (the infra provisioner sets both to the same
 * access point at /data). So a path under the data dir maps to a sub-path by
 * stripping the data dir: agents/<slug>/workspace, volumes/<id>. The database
 * and the skillset cache are deliberately placed outside the data dir, so
 * this is only correct for workspaces and shared volumes.
 *
 * Both sides are resolved through symlinks before comparing. The data dir
 * itself is never a mount. Not isRealPathWithinDir: the relative path needs
 * both realpaths anyway.
 */
export function storageSubPath(hostPath: string): string | null {
  let root: string
  let target: string
  try {
    root = fs.realpathSync(getDataDir())
    target = fs.realpathSync(hostPath)
  } catch {
    return null
  }
  if (!isPathWithinDir(root, target)) return null
  const rel = path.relative(root, target)
  if (rel === '') return null
  return rel.split(path.sep).join('/')
}

/**
 * Get the workspace directory for a specific agent.
 */
export function getAgentWorkspaceDir(agentId: string): string {
  return path.join(getAgentsDataDir(), agentId, 'workspace')
}

/**
 * Get the downloads directory for a specific agent's workspace.
 * Creates the directory if it doesn't exist.
 */
export function getAgentDownloadsDir(agentId: string): string {
  const dir = path.join(getAgentWorkspaceDir(agentId), 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
