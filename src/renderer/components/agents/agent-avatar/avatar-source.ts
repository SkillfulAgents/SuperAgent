import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { OFFERED_ORBS, hexMix, type AvatarOrb } from '@shared/lib/types/agent-avatar-orbs'
import { ORB_SHAPES, type OrbShape } from '@shared/lib/types/agent-avatar-shapes'

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

/**
 * Where an orb needs a ground under it (its Slack app icon, its face in a
 * stack of people), it fills this much of it.
 */
export const ORB_ON_GROUND_FILL = 0.7
/** How far the rim is taken toward white. */
const ORB_GROUND_PALENESS = 0.85
/**
 * The ground under an orb's app icon: a pale tint of its own rim, so every
 * colourway (the black one too) stands off whatever the icon is shown on.
 */
export function orbGround(orb: Pick<AvatarOrb, 'rim'>): string {
  return hexMix(orb.rim, '#FFFFFF', ORB_GROUND_PALENESS)
}
