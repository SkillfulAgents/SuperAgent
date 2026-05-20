import {
  getAgentPreferencesPath,
  readFileOrNull,
  writeFile,
} from '@shared/lib/utils/file-storage'
import {
  agentPreferencesSchema,
  type AgentPreferences,
} from '@shared/lib/types/agent-preferences'

export async function readAgentPreferences(
  agentSlug: string
): Promise<AgentPreferences> {
  const prefsPath = getAgentPreferencesPath(agentSlug)
  const content = await readFileOrNull(prefsPath)

  if (!content) {
    return {}
  }

  try {
    const parsed = JSON.parse(content)
    return agentPreferencesSchema.parse(parsed)
  } catch {
    console.warn(`Failed to parse agent preferences for ${agentSlug}`)
    return {}
  }
}

export async function writeAgentPreferences(
  agentSlug: string,
  prefs: AgentPreferences
): Promise<void> {
  const validated = agentPreferencesSchema.parse(prefs)
  const prefsPath = getAgentPreferencesPath(agentSlug)
  await writeFile(prefsPath, JSON.stringify(validated, null, 2))
}

export async function updateAgentPreferences(
  agentSlug: string,
  updates: Record<string, unknown>
): Promise<AgentPreferences> {
  const current = await readAgentPreferences(agentSlug)

  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }

  const validated = agentPreferencesSchema.parse(merged)
  await writeAgentPreferences(agentSlug, validated)
  return validated
}
