import * as fs from 'fs'
import * as path from 'path'
import { getAgentWorkspaceDir, writeJsonFileAtomic } from '@shared/lib/utils/file-storage'
import {
  claudeSettingsWithHooksSchema,
  type AgentHook,
  type ClaudeHooksConfig,
  type RemoveAgentHookTarget,
} from './agent-hooks-schema'

/**
 * Reads and edits the `hooks` key of an agent workspace's Claude settings file
 * (`<workspace>/.claude/settings.json`). The workspace is host-mounted, so
 * this works whether the agent container is running or cold. The file is
 * shared with the CLI (and with the agent itself, which can write it), so
 * edits touch ONLY the `hooks` key and preserve everything else.
 */

function getClaudeSettingsPath(agentSlug: string): string {
  return path.join(getAgentWorkspaceDir(agentSlug), '.claude', 'settings.json')
}

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
 * to one row per hook command. Returns [] when the file is missing, is not
 * valid JSON, or has no hooks key.
 */
export async function readAgentHooks(agentSlug: string): Promise<AgentHook[]> {
  const settingsPath = getClaudeSettingsPath(agentSlug)
  const content = await fs.promises.readFile(settingsPath, 'utf-8').catch(() => null)
  if (!content) return []

  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return []
  }
  const parsed = claudeSettingsWithHooksSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.hooks) return []
  return flattenHooks(parsed.data.hooks)
}

/**
 * Remove every hook matching the target (event + matcher + command/prompt)
 * from the agent's workspace settings file. Matcher-less groups match a
 * matcher-less target. Empty matcher groups and empty event arrays are pruned;
 * all other settings keys round-trip untouched. Throws when the settings file
 * is unreadable or not valid JSON — a removal must never silently rewrite a
 * file it couldn't faithfully parse.
 */
export async function removeAgentHook(
  agentSlug: string,
  target: RemoveAgentHookTarget
): Promise<AgentHook[]> {
  const settingsPath = getClaudeSettingsPath(agentSlug)
  const content = await fs.promises.readFile(settingsPath, 'utf-8')
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error('Agent settings file is not valid JSON; refusing to rewrite it')
  }
  // Parse with the boundary schema; passthrough keeps every key we don't model.
  const settings = claudeSettingsWithHooksSchema.parse(raw)
  if (!settings.hooks) return []

  const targetMatcher = target.matcher ?? ''
  // Every provided discriminator must match (schema guarantees at least one).
  const matchesTarget = (hook: { command?: string; prompt?: string }): boolean =>
    (target.command === undefined || hook.command === target.command) &&
    (target.prompt === undefined || hook.prompt === target.prompt)
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

  const updatedSettings: Record<string, unknown> = { ...settings }
  if (Object.keys(updatedHooks).length > 0) {
    updatedSettings.hooks = updatedHooks
  } else {
    delete updatedSettings.hooks
  }

  await writeJsonFileAtomic(settingsPath, updatedSettings)
  return Object.keys(updatedHooks).length > 0 ? flattenHooks(updatedHooks) : []
}
