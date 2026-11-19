import { z } from 'zod'

// Keep in sync with agent-container/src/file-hooks/agent-identity-hook.ts,
// which tells the agent when the host will not take what it wrote.
export const AGENT_NAME_MAX_LENGTH = 80
export const AGENT_DESCRIPTION_MAX_LENGTH = 200

/** The frontmatter parser reads one line per key, so a YAML block indicator (`>`, `|-`) is all it sees of a block value. */
const notBlockIndicator = (value: string) => !/^[>|][+-]?$/.test(value)

/**
 * A name or description the agent wrote into its own instructions
 * frontmatter, as the catalog row takes it. A value that fails leaves that
 * column alone.
 */
export const workspaceAgentNameSchema = z.string().trim().min(1).max(AGENT_NAME_MAX_LENGTH).refine(notBlockIndicator)
export const workspaceAgentDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_DESCRIPTION_MAX_LENGTH)
  .refine(notBlockIndicator)
