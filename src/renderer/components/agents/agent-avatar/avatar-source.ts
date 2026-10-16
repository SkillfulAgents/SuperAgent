import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { OFFERED_ORBS, type AvatarOrb } from './avatar-orbs'
import { ORB_SHAPES, type OrbShape } from './orb-shapes'

export interface AvatarSource {
  orb: AvatarOrb
  shape: OrbShape
}

/** Resolve persisted names; palette order never determines an agent's appearance. */
export function avatarSource(avatar: AgentAvatar): AvatarSource {
  return {
    orb: OFFERED_ORBS.find(orb => orb.name === avatar.color)!,
    shape: ORB_SHAPES.find(shape => shape.name === avatar.shape)!,
  }
}
