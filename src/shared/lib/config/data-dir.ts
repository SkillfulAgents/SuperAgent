import path from 'path'
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
 */
export function getDatabasePath(): string {
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
 * Get the workspace directory for a specific agent.
 */
export function getAgentWorkspaceDir(agentId: string): string {
  return path.join(getAgentsDataDir(), agentId, 'workspace')
}
