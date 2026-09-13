import { agentRegistry } from '@shared/lib/agent-actor'
import type { AgentHook, ClaudeHooksConfig, RemoveAgentHookTarget } from './agent-hooks-schema'

/**
 * Reads and edits the `hooks` key of an agent workspace's Claude settings
 * document (`.claude/settings.json`, the actor's `claudeSettings` config
 * document). The workspace is host-mounted, so this works whether the agent
 * container is running or cold. The file is shared with the CLI (and with the
 * agent itself, which can write it), so edits touch ONLY the `hooks` key and
 * preserve everything else (the document schema passes unknown keys through).
 */

function flattenHooks(config: ClaudeHooksConfig): AgentHook[] {
  const rows: AgentHook[] = []
  for (const [event, groups] of Object.entries(config)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        rows.push({
          event,
          ...(group.matcher !== undefined && { matcher: group.matcher }),
          ...(hook.type !== undefined && { type: hook.type }),
          ...(hook.command !== undefined && { command: hook.command }),
          ...(hook.prompt !== undefined && { prompt: hook.prompt }),
          ...(hook.timeout !== undefined && { timeout: hook.timeout }),
        })
      }
    }
  }
  return rows
}

/**
 * List the hooks configured in the agent's workspace settings file, flattened
 * to one row per hook command. Returns [] when the file is missing, cannot be
 * read, is not valid JSON, or has no hooks key.
 */
export async function readAgentHooks(agentSlug: string): Promise<AgentHook[]> {
  let settings
  try {
    settings = await agentRegistry.get(agentSlug).config.get('claudeSettings')
  } catch {
    // Missing, unreadable, or corrupt (`ConfigDocError`) all read as no hooks.
    return []
  }
  if (!settings?.hooks) return []
  return flattenHooks(settings.hooks)
}

/**
 * Remove every hook matching the target (event + matcher + command/prompt)
 * from the agent's workspace settings file. Matcher-less groups match a
 * matcher-less target. Empty matcher groups and empty event arrays are pruned;
 * all other settings keys round-trip untouched. Throws when the settings file
 * is missing, or is not valid JSON (`ConfigDocError`, raised before anything
 * is written) — a removal must never silently rewrite a file it couldn't
 * faithfully parse.
 */
export async function removeAgentHook(
  agentSlug: string,
  target: RemoveAgentHookTarget
): Promise<AgentHook[]> {
  const targetMatcher = target.matcher ?? ''
  // Every provided discriminator must match (schema guarantees at least one).
  const matchesTarget = (hook: { command?: string; prompt?: string }): boolean =>
    (target.command === undefined || hook.command === target.command) &&
    (target.prompt === undefined || hook.prompt === target.prompt)

  const updated = await agentRegistry.get(agentSlug).config.update('claudeSettings', (settings) => {
    if (settings === null) throw new Error('Agent settings file not found')
    if (!settings.hooks) return settings

    const updatedHooks: ClaudeHooksConfig = {}
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (event !== target.event) {
        updatedHooks[event] = groups
        continue
      }
      const updatedGroups = groups
        .map((group) => {
          if ((group.matcher ?? '') !== targetMatcher) return group
          return {
            ...group,
            hooks: (group.hooks ?? []).filter((hook) => !matchesTarget(hook)),
          }
        })
        .filter((group) => (group.hooks ?? []).length > 0)
      if (updatedGroups.length > 0) {
        updatedHooks[event] = updatedGroups
      }
    }

    const updatedSettings = { ...settings }
    if (Object.keys(updatedHooks).length > 0) {
      updatedSettings.hooks = updatedHooks
    } else {
      delete updatedSettings.hooks
    }
    return updatedSettings
  })

  return updated.hooks ? flattenHooks(updated.hooks) : []
}
