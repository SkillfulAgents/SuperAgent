import { getSettings } from '@shared/lib/config/settings'
import { resolveConnectionSelection, storedSelection } from '@shared/lib/llm-provider/connections'
import { agentRegistry, ConfigDocError } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import {
  agentPreferencesSchema,
  type AgentPreferences,
} from '@shared/lib/types/agent-preferences'

/**
 * Strict read: returns `{}` only when the document is absent; a corrupt/torn
 * document THROWS (`ConfigDocError`) so the read-modify-write aborts instead of
 * overwriting.
 */
async function readAgentPreferencesStrict(agentSlug: string): Promise<AgentPreferences> {
  return (await agentRegistry.get(agentSlug).config.get('preferences')) ?? {}
}

/**
 * Read prefs for READ-ONLY consumers. Fail-open: ANY read failure — corrupt
 * document, EACCES after a container-side ownership flip, transient FS errors —
 * degrades to `{}` (logged + captured) rather than throwing. Preferences only
 * supply defaults, and every session-spawn site reads them, so a throw here
 * would take down session creation for the agent. This never writes — only the
 * serialized {@link updateAgentPreferences} writes, and its strict read still
 * aborts on any failure so a broken document is never overwritten.
 */
export async function readAgentPreferences(
  agentSlug: string
): Promise<AgentPreferences> {
  let prefs: AgentPreferences
  try {
    prefs = await readAgentPreferencesStrict(agentSlug)
  } catch (error) {
    const kind = error instanceof ConfigDocError ? 'Corrupt' : 'Unreadable'
    console.error(`${kind} agent preferences for ${agentSlug}; using empty (NOT overwriting)`, error)
    captureException(error, { tags: { area: 'agent-preferences', op: 'read' }, extra: { agentSlug } })
    return {}
  }
  if (getSettings().llmDefault && prefs.defaultModel) {
    const selected = await resolveConnectionSelection(storedSelection(prefs.defaultModel, prefs.defaultConnectionId))
    if (!selected) return { ...prefs, defaultModel: undefined, defaultConnectionId: null }
    if (prefs.defaultConnectionId === undefined) {
      await agentRegistry.get(agentSlug).config.update('preferences', current => {
        if (!current || current.defaultModel !== prefs.defaultModel || current.defaultConnectionId !== undefined) return current
        return { ...current, defaultModel: selected.model, defaultConnectionId: selected.connectionId }
      })
    }
    return { ...prefs, defaultModel: selected.model, defaultConnectionId: selected.connectionId }
  }
  return prefs
}

export async function writeAgentPreferences(
  agentSlug: string,
  prefs: AgentPreferences
): Promise<void> {
  const validated = agentPreferencesSchema.parse(prefs)
  await agentRegistry.get(agentSlug).config.put('preferences', validated)
}

export async function updateAgentPreferences(
  agentSlug: string,
  updates: Record<string, unknown>
): Promise<AgentPreferences> {
  // Serialized read-modify-write: fresh STRICT read (a corrupt document aborts
  // the update, never synthesizes {} from a parse error), merge, atomic write.
  const updated = await agentRegistry.get(agentSlug).config.update('preferences', (current) => {
    const merged: Record<string, unknown> = { ...(current ?? {}) }
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        if (key === 'defaultConnectionId') merged[key] = null
        else delete merged[key]
      } else {
        merged[key] = value
      }
    }
    // New model-only writes bind to the current account. Only old documents
    // without an ID are eligible for the one-time legacy migration.
    if (Object.hasOwn(updates, 'defaultModel')) {
      if (!updates.defaultModel) merged.defaultConnectionId = null
      else if (!Object.hasOwn(updates, 'defaultConnectionId')) {
        const connectionId = current?.defaultConnectionId ?? getSettings().llmDefault?.connectionId
        if (connectionId) merged.defaultConnectionId = connectionId
      }
    }
    return agentPreferencesSchema.parse(merged)
  })
  // The mutator always returns a document, so there is one afterwards.
  return updated ?? agentPreferencesSchema.parse({})
}
