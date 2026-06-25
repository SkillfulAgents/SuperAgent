/**
 * Secrets Service
 *
 * File-based operations for agent secrets.
 * Secrets are stored in .env files in the agent workspace.
 */

import {
  getAgentEnvPath,
  getAgentWorkspaceDir,
  readFileOrNull,
  writeFileAtomic,
  withCrossProcessFileLock,
  ensureDirectory,
  fileExists,
} from '@shared/lib/utils/file-storage'
import { AgentSecret } from '@shared/lib/types/agent'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'

// ============================================================================
// .env File Parsing
// ============================================================================

/**
 * Parse .env file content into key-value pairs
 * Handles comments, empty lines, and quoted values
 *
 * Format:
 * # Comment
 * KEY=value
 * ANOTHER_KEY="quoted value"
 * KEY_WITH_COMMENT=value  # Display Name
 */
export function parseEnvFile(content: string): Map<string, { value: string; comment?: string }> {
  const result = new Map<string, { value: string; comment?: string }>()
  const lines = content.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines and comment-only lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    // Parse KEY=VALUE format
    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex === -1) {
      continue
    }

    const key = trimmed.substring(0, equalsIndex).trim()

    // Get value and optional comment
    let rest = trimmed.substring(equalsIndex + 1)
    let value: string
    let comment: string | undefined

    // Check for inline comment (but not inside quotes)
    const commentMatch = rest.match(/^(".*?"|'.*?'|[^#]*?)\s*#\s*(.*)$/)
    if (commentMatch) {
      value = commentMatch[1].trim()
      comment = commentMatch[2].trim()
    } else {
      value = rest.trim()
    }

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    result.set(key, { value, comment })
  }

  return result
}

/**
 * Serialize secrets to .env format
 * Includes header comment and display names as inline comments
 */
export function serializeEnvFile(secrets: AgentSecret[]): string {
  const lines: string[] = [
    '# Superagent Secrets',
    '# Format: ENV_VAR=value  # Display Name',
    '',
  ]

  for (const secret of secrets) {
    // Quote values that contain spaces, quotes, or special characters
    let value = secret.value
    if (
      value.includes(' ') ||
      value.includes('"') ||
      value.includes("'") ||
      value.includes('#') ||
      value.includes('\n')
    ) {
      // Escape double quotes and wrap in double quotes
      value = `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    }

    // Add inline comment with display name if different from env var
    if (secret.key !== secret.envVar) {
      lines.push(`${secret.envVar}=${value}  # ${secret.key}`)
    } else {
      lines.push(`${secret.envVar}=${value}`)
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Convert display name to environment variable name
 * "My API Key" -> "MY_API_KEY"
 */
export function keyToEnvVar(key: string): string {
  return key
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// ============================================================================
// Secrets Operations
// ============================================================================

/**
 * List all secrets for an agent
 */
export async function listSecrets(agentSlug: string): Promise<AgentSecret[]> {
  const envPath = getAgentEnvPath(agentSlug)
  const content = await readFileOrNull(envPath)

  if (!content) {
    return []
  }

  const parsed = parseEnvFile(content)
  const secrets: AgentSecret[] = []

  for (const [envVar, { value, comment }] of parsed) {
    secrets.push({
      envVar,
      value,
      // Use comment as display name, or env var if no comment
      key: comment || envVar,
    })
  }

  return secrets
}

/**
 * List the user-managed secrets for an agent — the subset of the agent .env
 * that users actually own and edit via the Secrets UI.
 *
 * The agent's /workspace/.env doubles as the container runtime env file: the
 * container's POST /env handler (server.ts updateEnvFile) writes reserved
 * runtime vars such as CONNECTED_ACCOUNTS into it so uv/python scripts can read
 * them. Those are system-managed (see RESERVED_ENV_VAR_KEYS / SUP-210) and must
 * not surface as user-editable secrets (SUP-239 bug 3).
 *
 * listSecrets() stays unfiltered for runtime consumers (getSecretEnvVars), which
 * legitimately need every var passed to the session.
 */
export async function listUserSecrets(agentSlug: string): Promise<AgentSecret[]> {
  const secrets = await listSecrets(agentSlug)
  return secrets.filter((s) => !isReservedEnvVar(s.envVar))
}

/**
 * Get a single secret by env var name
 */
export async function getSecret(
  agentSlug: string,
  envVar: string
): Promise<AgentSecret | null> {
  const secrets = await listSecrets(agentSlug)
  return secrets.find((s) => s.envVar === envVar) || null
}

/**
 * Add or update a secret
 */
export async function setSecret(agentSlug: string, secret: AgentSecret): Promise<void> {
  // Ensure workspace directory exists
  const workspaceDir = getAgentWorkspaceDir(agentSlug)
  await ensureDirectory(workspaceDir)

  const envPath = getAgentEnvPath(agentSlug)
  // The agent .env is written by BOTH this app AND the container's POST /env
  // handler (reserved runtime vars). Serialize across processes with an on-disk
  // lock the container honors too, re-read FRESH under the lock, and write
  // atomically (SUP-313) so an interleaved/interrupted write can't drop other
  // secrets or truncate the file (which doubles as the container runtime env).
  // mode 0o666 is preserved so the container (different uid) can still write it.
  await withCrossProcessFileLock(envPath, async () => {
    const secrets = await listSecrets(agentSlug)

    const existingIndex = secrets.findIndex((s) => s.envVar === secret.envVar)
    if (existingIndex >= 0) {
      secrets[existingIndex] = secret
    } else {
      secrets.push(secret)
    }

    await writeFileAtomic(envPath, serializeEnvFile(secrets), { mode: 0o666 })
  })
}

/**
 * Delete a secret
 */
export async function deleteSecret(agentSlug: string, envVar: string): Promise<boolean> {
  const envPath = getAgentEnvPath(agentSlug)
  return withCrossProcessFileLock(envPath, async () => {
    const secrets = await listSecrets(agentSlug)
    const filtered = secrets.filter((s) => s.envVar !== envVar)

    if (filtered.length === secrets.length) {
      return false // Secret didn't exist
    }

    if (filtered.length === 0) {
      // No secrets left — leave an empty (but valid) header file.
      await writeFileAtomic(envPath, '# Superagent Secrets\n', { mode: 0o666 })
    } else {
      await writeFileAtomic(envPath, serializeEnvFile(filtered), { mode: 0o666 })
    }

    return true
  })
}

/**
 * Check if any secrets exist for an agent
 */
export async function hasSecrets(agentSlug: string): Promise<boolean> {
  const envPath = getAgentEnvPath(agentSlug)
  if (!(await fileExists(envPath))) {
    return false
  }

  const secrets = await listSecrets(agentSlug)
  return secrets.length > 0
}

/**
 * Get list of env var names (for passing to container session)
 */
export async function getSecretEnvVars(agentSlug: string): Promise<string[]> {
  const secrets = await listSecrets(agentSlug)
  return secrets.map((s) => s.envVar)
}
