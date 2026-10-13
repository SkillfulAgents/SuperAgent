import { z } from 'zod'

// Persisted IDs are independent of palette order; renames require a data migration.
export const DEFAULT_AGENT_AVATAR_COLORS = [
  'tonal-red', 'tonal-orange', 'tonal-amber', 'tonal-green', 'tonal-forest',
  'tonal-teal', 'tonal-blue', 'tonal-cobalt', 'tonal-purple', 'tonal-blush',
  'tonal-pink', 'tonal-brown',
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
export type AgentAvatarColor = AgentAvatar['color']
export type AgentAvatarShape = AgentAvatar['shape']
