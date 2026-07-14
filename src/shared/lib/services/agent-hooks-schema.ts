import { z } from 'zod'

/**
 * Boundary schemas for the `hooks` key of the Claude Code CLI settings file in
 * an agent workspace (`<workspace>/.claude/settings.json`). Hooks are shell
 * commands the CLI executes at lifecycle events; agents can (and do) write
 * them into their own settings file, so the host surfaces and manages them.
 *
 * Everything is a loose object: we only model what we display/remove, and the
 * file is shared with the CLI — unknown keys must survive round-trips.
 */

export const hookCommandSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
})

export const hookMatcherGroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema).optional(),
})

/** The `hooks` key: event name → matcher groups. */
export const claudeHooksConfigSchema = z.record(z.string(), z.array(hookMatcherGroupSchema))

/** Whole settings file, modeling only `hooks` (passthrough preserves the rest). */
export const claudeSettingsWithHooksSchema = z.looseObject({
  hooks: claudeHooksConfigSchema.optional(),
})

export type ClaudeHooksConfig = z.infer<typeof claudeHooksConfigSchema>

/** One configured hook command, flattened for display. */
export interface AgentHook {
  /** Lifecycle event, e.g. "UserPromptSubmit", "PreToolUse". */
  event: string
  /** Tool-name matcher (PreToolUse/PostToolUse); empty for events without one. */
  matcher?: string
  /** Hook implementation type; command hooks are the only kind the CLI runs from settings. */
  type?: string
  command?: string
  timeout?: number
}

/** Events that can veto work outright — worth a louder UI treatment. */
export const BLOCKING_HOOK_EVENTS = new Set(['UserPromptSubmit'])

/** Body of a hook-removal request: identifies hook entries by content, not index. */
export const removeAgentHookSchema = z.object({
  event: z.string().min(1),
  command: z.string().min(1),
  matcher: z.string().optional(),
})

export type RemoveAgentHookTarget = z.infer<typeof removeAgentHookSchema>
