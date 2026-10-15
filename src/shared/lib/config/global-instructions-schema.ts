import { z } from 'zod'

/**
 * Global guidance is rendered into the system prompt of every agent session,
 * so it is bounded: past this it stops being guidance and starts crowding out
 * the agent's own context. Mirrored by the container's boundary schema
 * (agent-container/src/global-instructions.ts).
 */
export const GLOBAL_INSTRUCTIONS_MAX_LENGTH = 20_000

export const globalInstructionsSchema = z.string().max(GLOBAL_INSTRUCTIONS_MAX_LENGTH)
