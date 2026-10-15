import { useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useAgent } from '@renderer/hooks/use-agents'
import { useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { recallConfigSchema } from '@shared/lib/meeting-integrations/recall/config'
import { MEETING_INSTRUCTIONS_MAX_CHARS, MEETING_RECORDING_RETENTION_HOURS } from '@shared/lib/meeting-integrations/schemas'
import { IntegrationSetupLayout, IntegrationSetupField, IntegrationSetupFeedback, IntegrationSetupTextArea } from './integration-setup-layout'
import type { IntegrationSetupProps } from './setup-types'

/**
 * Meetings run through the Platform, so there is no key to paste: the choices
 * are the name the agent appears under in calls (the agent's own name until
 * edited) and standing instructions for every meeting it joins. The form is
 * offered only where the deployment can host meeting bots (see provider availability).
 */
export function RecallSetupForm({ agentSlug, onClose }: IntegrationSetupProps) {
  const formId = useId()
  const { data: agent } = useAgent(agentSlug)
  // null until the person types: the field follows the agent's name as it loads.
  const [typedName, setTypedName] = useState<string | null>(null)
  const botName = typedName ?? agent?.name ?? ''
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateAgentIntegration()
  const navigate = useNavigate()
  const retentionDays = Math.round(MEETING_RECORDING_RETENTION_HOURS / 24)

  return <IntegrationSetupLayout
    provider="recall"
    label="Meetings"
    instructions={<>
      <ol className="list-decimal list-outside ml-5 space-y-2.5 text-sm font-normal text-foreground">
        <li>Pick the name the agent appears under in calls, and optionally give it standing instructions that apply to every meeting it joins. Both can be changed later on the integration page.</li>
        <li>Once connected, paste a Zoom, Google Meet or Microsoft Teams invite link on the integration page and the agent joins as a voice participant. Hosts may need to admit it from the waiting room.</li>
      </ol>
      <p className="text-xs text-muted-foreground">The bot records the audio of each call for its notes and says so in the call chat when it joins. Recordings are kept for {retentionDays} days and can be played back from the integration page until then. Meeting bot time is billed to your Platform account.</p>
    </>}
    feedback={error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    actions={
      <Button size="sm" type="submit" form={formId} disabled={create.isPending}>
        {create.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Connecting…</> : 'Connect'}
      </Button>
    }
  >
    <form id={formId} className="space-y-3" onSubmit={async event => {
      event.preventDefault()
      if (create.isPending) return
      setError(null)
      const parsed = recallConfigSchema.safeParse({
        ...(botName.trim() ? { botName: botName.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      })
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the name and instructions'); return }
      try {
        const result = await create.mutateAsync({ agentSlug, provider: 'recall', name: parsed.data.botName ?? agent?.name, config: parsed.data })
        onClose()
        void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: result.id } })
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not set up meetings') }
    }}>
      <IntegrationSetupField id="recall-bot-name" label="Name in calls" placeholder="Agent" value={botName} onChange={event => setTypedName(event.target.value)} maxLength={100} disabled={create.isPending} />
      <IntegrationSetupTextArea id="recall-instructions" label="Instructions for every meeting" optional rows={4} placeholder="Introduce yourself when asked. Keep answers under two sentences. Track action items with owners." value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={MEETING_INSTRUCTIONS_MAX_CHARS} disabled={create.isPending} />
    </form>
  </IntegrationSetupLayout>
}
