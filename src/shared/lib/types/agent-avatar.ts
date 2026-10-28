import { z } from 'zod'
import { randomIndex } from '@shared/lib/utils/agent-id'

// Persisted IDs are independent of palette order; renames require a data migration.
export const DEFAULT_AGENT_AVATAR_COLORS = [
  'tonal-red', 'tonal-orange', 'tonal-amber', 'tonal-green', 'tonal-forest',
  'tonal-teal', 'tonal-blue', 'tonal-cobalt', 'tonal-purple', 'tonal-blush',
  'tonal-pink', 'tonal-brown', 'tonal-chocolate', 'tonal-white', 'tonal-grey',
  'tonal-black',
] as const

export const AGENT_AVATAR_COLORS = [
  ...DEFAULT_AGENT_AVATAR_COLORS,
  'duo-red-amber', 'duo-green-amber', 'duo-forest-teal', 'duo-teal-blush',
  'duo-blue-amber', 'duo-cobalt-teal', 'duo-pink-blue', 'duo-brown-amber',
] as const

export const AGENT_AVATAR_SHAPES = [
  'circle', 'squircle', 'triangle', 'diamond', 'hexagon', 'pill', 'arch', 'bloom',
] as const

export const agentAvatarSchema = z.object({
  color: z.enum(AGENT_AVATAR_COLORS),
  shape: z.enum(AGENT_AVATAR_SHAPES),
}).strict()

export type AgentAvatar = z.infer<typeof agentAvatarSchema>

/** A random color and shape, assigned once when an agent is created or imported. */
export function randomAgentAvatar(): AgentAvatar {
  return {
    color: DEFAULT_AGENT_AVATAR_COLORS[randomIndex(DEFAULT_AGENT_AVATAR_COLORS.length)],
    shape: AGENT_AVATAR_SHAPES[randomIndex(AGENT_AVATAR_SHAPES.length)],
  }
}
export type AgentAvatarColor = AgentAvatar['color']
export type AgentAvatarShape = AgentAvatar['shape']
