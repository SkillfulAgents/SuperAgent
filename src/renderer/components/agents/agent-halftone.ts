import type { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import type { AgentAvatarColor } from '@shared/lib/types/agent-avatar'
import type { AvatarOrb } from '@shared/lib/types/agent-avatar-orbs'

type ActivityStatus = ReturnType<typeof getAgentActivityStatus>

/**
 * The agent card's halftone (the all-agents home page), as settings: shared with Agent Home and its sessions, which
 * draw the same grid as their background.
 */

/** The grid: its pitch, its largest dot, and how strongly it fades toward the edges. */
export const AGENT_HALFTONE_GRID = { spacing: 5, maxRadius: 1.3, vignette: 0.4 } as const

// Baked halftone render settings + per-state motion (chosen during exploration;
// the dev tweak panel that produced them lives on the animation-experiments-draft
// branch). flow_3d is the working/idle/sleeping identity; pulse (in the avatar's
// colour, or orange ink without one) is the needs-input state.
export const HALFTONE_STATE: Record<'sleeping' | 'idle' | 'working', { speed: number; dim: number; contrast: number }> = {
  // Clear separation: sleeping/idle are slow + faint + soft; working is notably
  // faster, fuller, and higher-contrast (bolder, denser dots).
  sleeping: { speed: 0.25, dim: 0.4, contrast: 1.35 },
  idle: { speed: 0.4, dim: 0.5, contrast: 1.4 },
  working: { speed: 0.9, dim: 1, contrast: 1.95 },
}

/** An agent with an avatar inks its halftone in the avatar's colour, its state carried by this opacity. */
export const AVATAR_INK_OPACITY: Record<ActivityStatus, number> = {
  sleeping: 0.45,
  idle: 0.7,
  working: 1,
  awaiting_input: 1,
}

/** A stable per-agent phase for the halftone, so cards aren't all animating in sync. */
export function hashSlug(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

/*
 * The avatar's ink, evened out across colours and themes. Drawn at one strength, the colours read very differently:
 * pink and purple shout on the light page, a deep green or brown all but vanishes on the dark one. So each colour's
 * strength is scaled by how far it actually stands from the page it's drawn on (its OKLab distance, which counts
 * lightness and colourfulness alike): a colour that stands out a lot is drawn fainter, one that barely does fuller.
 * On dark, the ink is the avatar's lighter core rather than its deep rim, which can sit almost on the page itself.
 * INK_TUNING then nudges any one colour by eye, on top.
 */

/** The page each theme draws on (globals.css --background): #ffffff, #1a1a1a. */
const INK_GROUND = { light: '#ffffff', dark: '#1a1a1a' } as const
/** The distance from the page a typical colour stands, which draws at its state's strength unscaled. */
const INK_TYPICAL_DISTANCE = 0.45
/**
 * Each theme's strength overall, on top: light dots on a dark page read stronger than dark dots on a light one at the
 * same distance, so dark is drawn fainter across the board.
 */
const INK_THEME_STRENGTH = { light: 1, dark: 0.75 } as const
/** How far a colour's strength may be scaled either way, so a near-invisible one isn't blown out. */
const INK_SCALE_RANGE = [0.5, 1.6] as const

/**
 * By-eye adjustments to a colour's strength in one theme, after the evening-out (a multiplier: 0.85 is 15% fainter).
 * Keyed by the avatar colour's persisted id.
 */
export const INK_TUNING: Partial<Record<AgentAvatarColor, { light?: number; dark?: number }>> = {
  // Still the loudest on the light page once evened out: its saturation reads stronger than its distance.
  'tonal-pink': { light: 0.85 },
}

function hexToOklab(hex: string): [number, number, number] {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/**
 * The avatar's halftone ink in a theme, at `strength` (the state's, or a backdrop's): its colour, and an opacity that
 * evens it out against the other colours (capped at 1).
 */
export function avatarHalftoneInk(orb: AvatarOrb, dark: boolean, strength: number): { color: string; opacity: number } {
  const color = dark ? orb.core : orb.rim
  const ink = hexToOklab(color)
  const ground = hexToOklab(dark ? INK_GROUND.dark : INK_GROUND.light)
  const distance = Math.hypot(ink[0] - ground[0], ink[1] - ground[1], ink[2] - ground[2])
  const scale = Math.min(INK_SCALE_RANGE[1], Math.max(INK_SCALE_RANGE[0], INK_TYPICAL_DISTANCE / Math.max(distance, 0.001)))
  const tuning = INK_TUNING[orb.name]?.[dark ? 'dark' : 'light'] ?? 1
  const theme = INK_THEME_STRENGTH[dark ? 'dark' : 'light']
  return { color, opacity: Math.min(1, strength * scale * tuning * theme) }
}
