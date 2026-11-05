import { getSettings, type AppSettings } from '@shared/lib/config/settings'
import { resolveConnectionSelection, storedSelection } from '@shared/lib/llm-provider/connections'
import { agentRegistry, ConfigDocError, updateConfigDoc } from '@shared/lib/agent-actor'
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
  agentSlug: string,
  /** The operation's settings, when the caller already read them. */
  settings?: AppSettings,
): Promise<AgentPreferences> {
  const prefs = await readStoredAgentPreferences(agentSlug)
  if (!prefs.defaultModel) return prefs
  const current = settings ?? await getSettings()
  if (current.llmDefault) {
    const selected = await resolveConnectionSelection(
      await storedSelection(prefs.defaultModel, prefs.defaultLlmProviderId, current), false, undefined, current)
    if (!selected) return { ...prefs, defaultModel: undefined, defaultLlmProviderId: null }
    return { ...prefs, defaultModel: selected.model, defaultLlmProviderId: selected.llmProviderId }
  }
  return prefs
}

/**
 * The agent's preferences as stored, without resolving its default model
 * against the connections (so without reading settings): for readers that do
 * not use the model, such as the retention sweeps. Unreadable preferences
 * read as empty, reported, never overwritten.
 */
export async function readStoredAgentPreferences(agentSlug: string): Promise<AgentPreferences> {
  try {
    return await readAgentPreferencesStrict(agentSlug)
  } catch (error) {
    const kind = error instanceof ConfigDocError ? 'Corrupt' : 'Unreadable'
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
  await agentRegistry.get(agentSlug).config.put('preferences', validated)
}

export async function updateAgentPreferences(
  agentSlug: string,
  updates: Record<string, unknown>
): Promise<AgentPreferences> {
  // A model-only write binds to the app default's account; read it up front,
  // since the mutator below may run more than once.
  const bindsToDefault = Object.hasOwn(updates, 'defaultModel') && !!updates.defaultModel
    && !Object.hasOwn(updates, 'defaultLlmProviderId')
  const defaultLlmProviderId = bindsToDefault ? (await getSettings()).llmDefault?.llmProviderId : undefined
  // Serialized read-modify-write: fresh STRICT read (a corrupt document aborts
  // the update, never synthesizes {} from a parse error), merge, atomic write.
  const updated = await updateConfigDoc(agentRegistry.get(agentSlug).config, 'preferences', (current) => {
    const merged: Record<string, unknown> = { ...(current ?? {}) }
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        if (key === 'defaultLlmProviderId') merged[key] = null
        else delete merged[key]
      } else {
        merged[key] = value
      }
    }
    // New model-only writes bind to the current account. Only old documents
    // without an ID are eligible for the one-time legacy migration.
    if (Object.hasOwn(updates, 'defaultModel')) {
      if (!updates.defaultModel) merged.defaultLlmProviderId = null
      else if (!Object.hasOwn(updates, 'defaultLlmProviderId')) {
        const llmProviderId = current?.defaultLlmProviderId ?? defaultLlmProviderId
        if (llmProviderId) merged.defaultLlmProviderId = llmProviderId
      }
    }
    return agentPreferencesSchema.parse(merged)
  })
  // The mutator always returns a document, so there is one afterwards.
  return updated ?? agentPreferencesSchema.parse({})
}
