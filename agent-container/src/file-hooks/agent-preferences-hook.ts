import { z } from 'zod'
import { FileHook, type FileHookReadResult, type FileHookWriteResult } from './file-hook'

// Keep in sync with src/shared/lib/types/agent-preferences.ts
const agentPreferencesSchema = z.object({
  autoDeleteInactiveDays: z.number().int().positive().optional(),
  defaultModel: z.string().trim().min(1).optional(),
  defaultEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  defaultSpeed: z.enum(['slow', 'normal', 'fast']).optional(),
})

const PREFERENCES_PATH = '/workspace/agent-preferences.json'

const READ_HINT = `This is the agent preferences file. It stores per-agent settings that override app-wide defaults.

Format: a JSON object with optional fields:
- "autoDeleteInactiveDays" (positive integer, optional): Automatically delete sessions inactive for this many days. Starred sessions are preserved.
- "defaultModel" (string, optional): Default model for this agent's new sessions — a concrete model id or a bare family alias. Per-session and per-trigger picks still win.
- "defaultEffort" (one of "low" | "medium" | "high" | "xhigh" | "max", optional): Default reasoning effort for this agent's new sessions.
- "defaultSpeed" (one of "slow" | "normal" | "fast", optional): Default processing speed for this agent's new sessions. Only speeds the model's serving path supports take effect.

Example:
{
  "autoDeleteInactiveDays": 90,
  "defaultModel": "opus",
  "defaultEffort": "high"
}

Omit a field or remove it to fall back to the app-wide default.`

export class AgentPreferencesFileHook extends FileHook {
  pattern(): string {
    return PREFERENCES_PATH
  }

  matches(filePath: string): boolean {
    return filePath === PREFERENCES_PATH
  }

  onRead(_filePath: string): FileHookReadResult {
    return { additionalContext: READ_HINT }
  }

  onWrite(_filePath: string, content: string): FileHookWriteResult {
    return this.validate(content)
  }

  onEdit(_filePath: string, contentAfterEdit: string): FileHookWriteResult {
    return this.validate(contentAfterEdit)
  }

  private validate(content: string): FileHookWriteResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      return { error: `agent-preferences.json must contain valid JSON: ${(e as Error).message}` }
    }

    const result = agentPreferencesSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `  - ${i.path.join('.')}: ${i.message}`
      ).join('\n')
      return { error: `agent-preferences.json validation failed:\n${issues}` }
    }

    return {}
  }
}
