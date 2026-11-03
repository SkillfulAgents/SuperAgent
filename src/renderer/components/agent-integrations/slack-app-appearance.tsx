import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgent } from '@renderer/hooks/use-agents'
import { saveBlob } from '@renderer/lib/download'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { CopyTextButton, SlackAppsLink } from './slack-delivery-card'
import { slackAppIcon, slackAppIdentity, type SlackAppAgent } from './slack-app-identity'

const where = <strong className="font-medium">Basic Information → Display Information</strong>

/** Downloads the agent's avatar as a Slack app icon. */
export function SlackAppIconButton({ agent }: { agent: SlackAppAgent }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  if (!agent.avatar) return null
  const download = async () => {
    setState('busy')
    try {
      saveBlob(await slackAppIcon(agent), `${agent.name.trim() || 'Agent'} icon.png`)
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={state === 'busy'} onClick={() => void download()} data-testid="slack-app-icon-download">
      {state === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AgentAvatar agent={agent} size={14} />}Download icon
    </Button>
    {state === 'failed' && <span role="alert" className="text-xs text-destructive">Couldn’t make the icon.</span>}
  </span>
}

function ColorSwatch({ color }: { color: string }) {
  return <span className="inline-flex items-center gap-2">
    <span className="inline-flex items-center gap-1.5 font-mono text-xs"><span className="h-3.5 w-3.5 rounded-sm border" style={{ background: color }} />{color}</span>
    <CopyTextButton text={color} label="Copy color" />
  </span>
}

/**
 * The setup step for what a manifest can't set: the icon, and, for an app
 * made without the manifest, its colour. Only for an agent with an avatar.
 */
export function SlackAppIconStep({ agent, withColor = false }: { agent: SlackAppAgent; withColor?: boolean }) {
  const { backgroundColor } = slackAppIdentity(agent)
  return <>
    Optional: in {where}, upload this agent’s avatar as the app icon{withColor && backgroundColor ? ' and set the background color' : ''}.
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <SlackAppIconButton agent={agent} />
      {withColor && backgroundColor && <ColorSwatch color={backgroundColor} />}
    </div>
  </>
}

/**
 * A connected Slack app's look, to match it to its agent by hand: the
 * manifest set its name and colour only when the app was created, and never
 * an icon.
 */
export function SlackAppAppearanceCard({ integration }: { integration: PublicAgentIntegration }) {
  const slack = publicSlackDelivery(integration)
  const { data: agent } = useAgent(integration.agentSlug)
  // Before the app is connected, its setup steps carry the icon.
  if (!slack?.botTokenSaved || !agent?.avatar) return null
  const { backgroundColor } = slackAppIdentity(agent)
  return <DetailCard label="Icon & Color">
    <div className="space-y-3" data-testid="slack-app-appearance">
      <p className="text-xs text-muted-foreground">To show this agent in Slack, open its app at <SlackAppsLink />, then in {where} upload the icon and set the background color.</p>
      <div className="flex flex-wrap items-center gap-3">
        <SlackAppIconButton agent={agent} />
        {backgroundColor && <ColorSwatch color={backgroundColor} />}
      </div>
    </div>
  </DetailCard>
}
