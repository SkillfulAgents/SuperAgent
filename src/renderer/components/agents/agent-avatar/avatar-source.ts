import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { OFFERED_ORBS, TEAM_BRAIN_ORB, type AvatarOrb, type OrbAppearance } from '@shared/lib/types/agent-avatar-orbs'
import { BRAIN_SHAPE, ORB_SHAPES, type AvatarShape, type OrbShape } from '@shared/lib/types/agent-avatar-shapes'

export interface AvatarSource {
  orb: OrbAppearance
  shape: OrbShape
}

/** A look an agent can persist: a palette colour and an offered shape. */
export interface AgentAvatarSource extends AvatarSource {
  orb: AvatarOrb
  shape: AvatarShape
}

/** Resolve persisted names; palette order never determines an agent's appearance. */
export function avatarSource(avatar: AgentAvatar): AgentAvatarSource {
  return {
    orb: OFFERED_ORBS.find(orb => orb.name === avatar.color)!,
    shape: ORB_SHAPES.find(shape => shape.name === avatar.shape)!,
  }
}

/** Team Brain's look, fixed: its agent's persisted avatar is never drawn. */
export const TEAM_BRAIN_AVATAR: AvatarSource = { orb: TEAM_BRAIN_ORB, shape: BRAIN_SHAPE }
