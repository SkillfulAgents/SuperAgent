import { z } from 'zod'

export const HINT_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const
export type HintEvent = (typeof HINT_EVENTS)[number]

/** tool_input field name → glob. `*` matches anything; see hint-matchers.ts. */
const fieldGlobsSchema = z.record(z.string().min(1), z.string().min(1, 'Glob must not be empty'))

// Strict so a misspelled key (e.g. `inputs`) fails loudly instead of matching every call.
const toolTriggerSchema = z
  .object({
    event: z.enum(['PreToolUse', 'PostToolUse']),
    tool: z.string().min(1, 'Tool name is required'),
    /** Every field must match its glob. */
    input: fieldGlobsSchema.optional(),
  })
  .strict()

const promptTriggerSchema = z
  .object({
    event: z.literal('UserPromptSubmit'),
    /** Case-insensitive regular expression on the prompt text. */
    prompt: z.string().min(1, 'Prompt pattern is required'),
  })
  .strict()

export const hintTriggerSchema = z.discriminatedUnion('event', [toolTriggerSchema, promptTriggerSchema])

export const hintFrontmatterSchema = z
  .object({
    name: z.string().min(1, 'Hint name is required'),
    description: z.string().min(1, 'Hint description is required'),
    triggers: z.array(hintTriggerSchema).min(1, 'Hint needs at least one trigger'),
    /** `turn`: first match per user message. `once`: first match per session. `always`: every match. */
    repeat: z.enum(['turn', 'once', 'always']).default('turn'),
    /** When the hint fires (per `repeat`), refuse the call with the body as the reason instead of adding it as context. */
    deny: z.boolean().optional(),
  })
  .refine((hint) => !hint.deny || hint.triggers.every((t) => t.event === 'PreToolUse'), {
    message: 'A deny hint can only have PreToolUse triggers',
    path: ['deny'],
  })

export type HintTrigger = z.infer<typeof hintTriggerSchema>
export type HintToolTrigger = z.infer<typeof toolTriggerSchema>
export type Hint = z.output<typeof hintFrontmatterSchema> & { content: string }
