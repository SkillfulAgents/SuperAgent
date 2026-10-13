import { randomInt } from 'node:crypto'
import { AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS, type AgentAvatar } from '@shared/lib/types/agent-avatar'

/** Assigned once on insertion, including imports. Reading an agent never randomizes it. */
export function randomAgentAvatar(): AgentAvatar {
  return {
    color: DEFAULT_AGENT_AVATAR_COLORS[randomInt(DEFAULT_AGENT_AVATAR_COLORS.length)],
    shape: AGENT_AVATAR_SHAPES[randomInt(AGENT_AVATAR_SHAPES.length)],
  }
}
