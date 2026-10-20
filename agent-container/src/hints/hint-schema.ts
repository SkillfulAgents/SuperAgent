import { z } from 'zod'

export const HINT_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const
export type HintEvent = (typeof HINT_EVENTS)[number]

/**
 * `match` syntax depends on the event:
 * - PreToolUse / PostToolUse: `Tool` or `Tool(pattern)`, e.g. `Bash(sleep *)`
 * - UserPromptSubmit: a case-insensitive regular expression on the prompt text
 */
export const hintTriggerSchema = z.object({
  event: z.enum(HINT_EVENTS),
  match: z.string().min(1, 'Trigger match is required'),
})

export const hintFrontmatterSchema = z.object({
  name: z.string().min(1, 'Hint name is required'),
  description: z.string().min(1, 'Hint description is required'),
  triggers: z.array(hintTriggerSchema).min(1, 'Hint needs at least one trigger'),
  /** `turn`: first match per user message. `once`: first match per session. `always`: every match. */
  repeat: z.enum(['turn', 'once', 'always']).default('turn'),
})

export type HintTrigger = z.infer<typeof hintTriggerSchema>
export type Hint = z.output<typeof hintFrontmatterSchema> & { content: string }

export type HintEventInput =
  | { event: 'UserPromptSubmit'; prompt: string }
  | { event: 'PreToolUse' | 'PostToolUse'; toolName: string; toolInput: unknown }
