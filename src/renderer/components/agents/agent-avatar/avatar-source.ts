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
 * Where an orb needs a round or square ground under it (an app icon, a face in
 * a stack of people), it stands on a wash of its own rim, so every colourway
 * (the black one too) stands off whatever is behind, and fills this much of
 * it. `paleness` is how far the rim is taken toward white: an app icon's is
 * nearly white, as it is shown on other apps' surfaces.
 */
export const ORB_ON_GROUND_FILL = 0.7
export const APP_ICON_GROUND_PALENESS = 0.85
export function orbGround(orb: Pick<AvatarOrb, 'rim'>, paleness: number): string {
  return hexMix(orb.rim, '#FFFFFF', paleness)
}
