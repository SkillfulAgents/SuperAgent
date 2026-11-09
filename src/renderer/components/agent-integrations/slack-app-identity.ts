import type { SlackAppIdentity } from '@shared/lib/chat-integrations/slack-manifest'
import type { ApiAgent } from '@shared/lib/types/api'
import { hexMix, type OrbAppearance } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { agentAppIcon } from './agent-app-icon'

export const DEFAULT_SLACK_APP_NAME = 'Gamut Bot'

export type SlackAppAgent = Pick<ApiAgent, 'slug' | 'name' | 'description' | 'avatar'>

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The orb's rim colour, darkened until the white name Slack writes on it
 * reads (4.5:1): an amber or blush rim is too light for it as it is.
 */
export function slackBackgroundColor(orb: OrbAppearance): string {
  for (let step = 0; step <= 20; step++) {
    const colour = hexMix(orb.rim, '#000000', step / 20)
    if (1.05 / (luminance(colour) + 0.05) >= 4.5) return colour
  }
  return '#000000'
}

/** The Slack app as its agent: the name given, else the agent's, and the agent's description and colour. */
export function slackAppIdentity(agent: SlackAppAgent | undefined, name?: string | null): SlackAppIdentity {
  return {
    name: name?.trim() || agent?.name.trim() || DEFAULT_SLACK_APP_NAME,
    description: agent?.description?.trim() || undefined,
    backgroundColor: agent?.avatar ? slackBackgroundColor(avatarSource(agent.avatar).orb) : undefined,
  }
}

/** The agent's avatar as a Slack app icon. A manifest can't carry an icon, so for an app made by hand it is uploaded by hand. */
export function slackAppIcon(agent: SlackAppAgent): Promise<Blob> {
  return agentAppIcon(agent)
}
