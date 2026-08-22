import path from 'path'
import fs from 'fs'
import os from 'os'

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
 * Get the path to the agents data directory.
 * This is where agent workspaces are stored.
 */
export function getAgentsDataDir(): string {
  return path.join(getDataDir(), 'agents')
}

/**
 * Shared Team Brain directory. Sibling of agents/, not inside any agent
 * workspace, so it survives agent deletion. On cloud this is the org data dir.
 */
export const BRAIN_INDEX_FILENAME = 'INDEX.md'
export const BRAIN_CURATOR_FILENAME = 'CURATOR'

const BRAIN_INDEX_STARTER = `# Team Brain

Curator-owned catalog. One line per page: \`- name — one-line description\`.
Update this file whenever you add, merge, or delete a page.
`

export function getBrainDir(): string {
  return path.join(getDataDir(), 'brain')
}

export function ensureBrainDir(): string {
  const dir = getBrainDir()
  fs.mkdirSync(dir, { recursive: true })
  const indexPath = path.join(dir, BRAIN_INDEX_FILENAME)
  try {
    fs.writeFileSync(indexPath, BRAIN_INDEX_STARTER, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  return dir
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
