import type { ApiAgent } from '@shared/lib/types/api'
import { orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { hexMix } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { orbSvg, svgToPng } from '@renderer/components/agents/agent-avatar/orb-image'

export type AppIconAgent = Pick<ApiAgent, 'slug' | 'avatar'>

/** Square, and inside the bounds app platforms take (Slack's are 512–2000px). */
const ICON_SIZE = 1024

/**
 * The agent's avatar as an app icon, for any provider's app: the orb at rest
 * on a pale wash of its rim, so every colourway (the black one too) stands
 * off the background it is shown on.
 */
export async function agentAppIcon(agent: AppIconAgent): Promise<Blob> {
  if (!agent.avatar) throw new Error('This agent has no avatar')
  const { orb, shape } = avatarSource(agent.avatar)
  const svg = orbSvg({ orb, shape, restingPhi: orbRestingPhi(agent.slug), size: ICON_SIZE, fill: 0.7, background: hexMix(orb.rim, '#FFFFFF', 0.85) })
  return svgToPng(svg, ICON_SIZE)
}

/** The agent's app icon as a base64 PNG, to send to the host (which uploads it to an app a directory created). */
export async function agentAppIconBase64(agent: AppIconAgent): Promise<string> {
  const bytes = new Uint8Array(await (await agentAppIcon(agent)).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
