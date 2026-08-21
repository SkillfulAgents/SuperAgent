import {
  getAgentPreferencesPath,
  readJsonFileStrict,
  writeJsonFileAtomic,
  withFileLock,
  CorruptFileError,
} from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import {
  agentPreferencesSchema,
  type AgentPreferences,
} from '@shared/lib/types/agent-preferences'

/**
 * Strict read: returns `{}` only when the file is absent; a corrupt/torn file
 * THROWS so the read-modify-write aborts instead of overwriting.
 */
async function readAgentPreferencesStrict(agentSlug: string): Promise<AgentPreferences> {
  const prefsPath = getAgentPreferencesPath(agentSlug)
  return readJsonFileStrict(prefsPath, agentPreferencesSchema, {})
}

/**
 * Read prefs for READ-ONLY consumers. Fail-open: ANY read failure — corrupt
 * file, EACCES after a container-side ownership flip, transient FS errors —
 * degrades to `{}` (logged + captured) rather than throwing. Preferences only
 * supply defaults, and every session-spawn site reads them, so a throw here
 * would take down session creation for the agent. This never writes — only the
 * serialized {@link updateAgentPreferences} writes, and its strict read still
 * aborts on any failure so a broken file is never overwritten.
 */
export async function readAgentPreferences(
  agentSlug: string
): Promise<AgentPreferences> {
  try {
    return await readAgentPreferencesStrict(agentSlug)
  } catch (error) {
    const kind = error instanceof CorruptFileError ? 'Corrupt' : 'Unreadable'
    console.error(`${kind} agent preferences for ${agentSlug}; using empty (NOT overwriting)`, error)
    captureException(error, { tags: { area: 'agent-preferences', op: 'read' }, extra: { agentSlug } })
    return {}
  }
}

export async function writeAgentPreferences(
  agentSlug: string,
  prefs: AgentPreferences
): Promise<void> {
  const validated = agentPreferencesSchema.parse(prefs)
  const prefsPath = getAgentPreferencesPath(agentSlug)
  await writeJsonFileAtomic(prefsPath, validated)
}

export async function updateAgentPreferences(
  agentSlug: string,
  updates: Record<string, unknown>
): Promise<AgentPreferences> {
  const prefsPath = getAgentPreferencesPath(agentSlug)
  // Serialized read-modify-write: fresh STRICT read (throws on corrupt → aborts,
  // never synthesizes {} from a parse error), merge, atomic write.
  return withFileLock(prefsPath, async () => {
    const current = await readAgentPreferencesStrict(agentSlug)

    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        delete merged[key]
      } else {
        merged[key] = value
      }
    }

    const validated = agentPreferencesSchema.parse(merged)
    await writeJsonFileAtomic(prefsPath, validated)
    return validated
  })
}
