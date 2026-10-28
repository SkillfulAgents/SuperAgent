import { z } from 'zod'

/**
 * Schema for the Claude Code CLI's settings.json, located at
 * `$CLAUDE_CONFIG_DIR/settings.json` (i.e. `/workspace/.claude/settings.json`
 * in the container). We only model the keys we manage; everything else is
 * preserved via the passthrough so we never clobber settings the CLI or a
 * skill may have written.
 */
export const claudeSettingsSchema = z.looseObject({
  // Days the CLI keeps session JSONL transcripts before its startup cleanup
  // prunes them. We pin this high so transcripts persist for the lifetime of
  // the agent workspace (default is ~30 days, which silently deletes old
  // sessions — they then show in the nav but fail to load).
  cleanupPeriodDays: z.number().optional(),
})

export type ClaudeSettings = z.infer<typeof claudeSettingsSchema>

// Retention window for session transcripts, in days. Effectively "never clean
// up" — agent workspaces are persistent volumes, so the CLI's age-based
// cleanup should not run.
export const SESSION_RETENTION_DAYS = 9999
