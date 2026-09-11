/**
 * Secrets Service
 *
 * Operations on an agent's secrets, which live in the agent's `secrets`
 * document: the workspace `.env`, read and written through the agent actor.
 * The actor serializes each read-modify-write with the on-disk lock the
 * container honours, writes atomically, and keeps the file at a mode the
 * container can read.
 */

import { agentRegistry, WorkspaceFileError } from '@shared/lib/agent-actor'
import { AgentSecret } from '@shared/lib/types/agent'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { keyToEnvVar } from '@shared/lib/utils/secrets'

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

    // Remove surrounding quotes. Double-quoted values also unescape the
    // sequences serializeEnvFile writes (\\ , \" , \n) — without this, a value
    // containing quotes gained an escape level on EVERY read-modify-write
    // cycle, progressively corrupting it. Single-quoted values stay literal.
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c))
    } else if (value.startsWith("'") && value.endsWith("'")) {
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
      // Escape backslashes first, then quotes and newlines, and wrap in double
      // quotes — the exact inverse of parseEnvFile's unescape, so values
      // round-trip byte-for-byte through repeated read-modify-write cycles.
      value = `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
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

// ============================================================================
// Secrets Operations
// ============================================================================

/** The secrets in a `.env` text, display name taken from the inline comment. */
function secretsFromEnv(content: string): AgentSecret[] {
  const secrets: AgentSecret[] = []

  for (const [envVar, { value, comment }] of parseEnvFile(content)) {
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
 * List all secrets for an agent
 */
export async function listSecrets(agentSlug: string): Promise<AgentSecret[]> {
  const content = await agentRegistry.get(agentSlug).config.get('secrets')

  if (!content) {
    return []
  }

  return secretsFromEnv(content)
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
  // The agent .env is written by BOTH this app AND the container's POST /env
  // handler (reserved runtime vars). The actor's `secrets` update re-reads
  // FRESH under the on-disk lock the container honors too and writes
  // atomically at the mode the container can read, so an interleaved or
  // interrupted write can't drop other secrets or truncate the file (which
  // doubles as the container runtime env).
  await agentRegistry.get(agentSlug).config.update('secrets', (current) => {
    const secrets = secretsFromEnv(current ?? '')

    const existingIndex = secrets.findIndex((s) => s.envVar === secret.envVar)
    if (existingIndex >= 0) {
      secrets[existingIndex] = secret
    } else {
      secrets.push(secret)
    }

    return serializeEnvFile(secrets)
  })
}

export type UpdateSecretResult =
  | { status: 'updated'; secret: AgentSecret }
  | { status: 'not_found' }
  | { status: 'conflict'; envVar: string }
  | { status: 'invalid_key' }
  | { status: 'reserved'; envVar: string }

/**
 * A locked read-modify-write over the agent's secrets whose mutator also
 * decides the caller's result. `mutate` sees the current secrets and the
 * current `.env` text, and returns the next text — `current` itself to leave
 * the file's content as it is — together with the result to hand back.
 */
async function updateSecrets<T>(
  agentSlug: string,
  mutate: (secrets: AgentSecret[], current: string) => { next: string; result: T },
): Promise<T> {
  let outcome: { result: T } | undefined
  await agentRegistry.get(agentSlug).config.update('secrets', (current) => {
    const text = current ?? ''
    const step = mutate(secretsFromEnv(text), text)
    outcome = { result: step.result }
    return step.next
  })
  if (!outcome) throw new Error('secrets update resolved without running its mutator')
  return outcome.result
}

/**
 * Update (and optionally rename) a secret as one locked read-modify-write.
 *
 * Renames must not be implemented as delete-then-set: a failed second write
 * loses the source, and a stale client can overwrite a concurrently-created
 * destination. This operation revalidates both names under the file lock.
 */
export async function updateSecret(
  agentSlug: string,
  currentEnvVar: string,
  patch: { key?: string; value?: string },
): Promise<UpdateSecretResult> {
  // A missing .env means there cannot be a source secret. Check before taking
  // the lock so a direct service call for an unknown agent does not create an
  // otherwise-empty agents/<slug>/workspace directory as a side effect.
  if (!(await agentRegistry.get(agentSlug).files.stat('.env'))) {
    return { status: 'not_found' }
  }

  return updateSecrets<UpdateSecretResult>(agentSlug, (secrets, current) => {
    const sourceIndex = secrets.findIndex((secret) => secret.envVar === currentEnvVar)
    if (sourceIndex < 0 || isReservedEnvVar(currentEnvVar)) {
      return { next: current, result: { status: 'not_found' } }
    }

    const existing = secrets[sourceIndex]
    const key = patch.key?.trim() || existing.key
    const envVar = keyToEnvVar(key)
    if (!envVar) return { next: current, result: { status: 'invalid_key' } }
    if (isReservedEnvVar(envVar)) return { next: current, result: { status: 'reserved', envVar } }

    const destinationIndex = secrets.findIndex((secret) => secret.envVar === envVar)
    if (destinationIndex >= 0 && destinationIndex !== sourceIndex) {
      return { next: current, result: { status: 'conflict', envVar } }
    }

    const updated = {
      key,
      envVar,
      value: patch.value !== undefined ? patch.value : existing.value,
    }
    secrets[sourceIndex] = updated
    return { next: serializeEnvFile(secrets), result: { status: 'updated', secret: updated } }
  })
}

/**
 * Delete a secret
 */
export async function deleteSecret(agentSlug: string, envVar: string): Promise<boolean> {
  // Nothing to delete if the .env (or its workspace dir) is absent. Short-circuit
  // BEFORE the locked update — it creates the workspace dir for its lock file, so
  // a call for an unknown agent would otherwise leave an empty workspace behind
  // instead of answering false (→ the route's 404 "Secret not found").
  if (!(await agentRegistry.get(agentSlug).files.stat('.env'))) {
    return false
  }
  return updateSecrets(agentSlug, (secrets, current) => {
    const filtered = secrets.filter((s) => s.envVar !== envVar)

    if (filtered.length === secrets.length) {
      return { next: current, result: false } // Secret didn't exist
    }

    if (filtered.length === 0) {
      // No secrets left — leave an empty (but valid) header file.
      return { next: '# Superagent Secrets\n', result: true }
    }

    return { next: serializeEnvFile(filtered), result: true }
  })
}

/**
 * Check if any secrets exist for an agent
 */
export async function hasSecrets(agentSlug: string): Promise<boolean> {
  if (!(await agentRegistry.get(agentSlug).files.stat('.env'))) {
    return false
  }

  const secrets = await listSecrets(agentSlug)
  return secrets.length > 0
}

/**
 * Get list of env var names (for passing to container session).
 *
 * This runs on EVERY session start, which makes it the host's self-heal point
 * for a .env poisoned by older builds (0o600 + owner flipped by an atomic
 * rename): reading the `secrets` document chmods the file back to the 0o666
 * contract when this process owns it. If it can't even read the file (the
 * container owns the poisoned copy), degrade to [] instead of failing session
 * creation — this consumer only surfaces NAMES to the agent, and the booting
 * container heals the file it owns on startup, so the next session recovers
 * fully. Mutating paths (setSecret/deleteSecret) stay strictly fail-closed.
 */
export async function getSecretEnvVars(agentSlug: string): Promise<string[]> {
  try {
    const secrets = await listSecrets(agentSlug)
    return secrets.map((s) => s.envVar)
  } catch (err) {
    // The actor reports a permission failure as `not-accessible`; the raw errno
    // is kept for anything that still throws one.
    const code = err instanceof WorkspaceFileError ? err.code : (err as NodeJS.ErrnoException)?.code
    if (code === 'not-accessible' || code === 'EACCES' || code === 'EPERM') {
      console.warn(
        `[secrets] ${agentSlug} .env unreadable (${code}) — starting session without secret names; ` +
          'the agent container heals the file permissions on boot'
      )
      return []
    }
    throw err
  }
}
