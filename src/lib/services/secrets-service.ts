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
  writeFile,
  ensureDirectory,
  fileExists,
} from '@/lib/utils/file-storage'
import { AgentSecret } from '@/lib/types/agent'

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

  // Get existing secrets
  const secrets = await listSecrets(agentSlug)

  // Find and update or add
  const existingIndex = secrets.findIndex((s) => s.envVar === secret.envVar)
  if (existingIndex >= 0) {
    secrets[existingIndex] = secret
  } else {
    secrets.push(secret)
  }

  // Write back
  const envPath = getAgentEnvPath(agentSlug)
  const content = serializeEnvFile(secrets)
  await writeFile(envPath, content, { mode: 0o600 }) // Restrictive permissions
}

/**
 * Delete a secret
 */
export async function deleteSecret(agentSlug: string, envVar: string): Promise<boolean> {
  const secrets = await listSecrets(agentSlug)
  const filtered = secrets.filter((s) => s.envVar !== envVar)

  if (filtered.length === secrets.length) {
    return false // Secret didn't exist
  }

  const envPath = getAgentEnvPath(agentSlug)

  if (filtered.length === 0) {
    // No secrets left, could delete file or leave empty
    await writeFile(envPath, '# Superagent Secrets\n', { mode: 0o600 })
  } else {
    const content = serializeEnvFile(filtered)
    await writeFile(envPath, content, { mode: 0o600 })
  }

  return true
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
