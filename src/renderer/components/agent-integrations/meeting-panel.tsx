import { useId, useState } from 'react'
import { Loader2, LogOut, Play, Video } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { TileStack } from '@renderer/components/ui/tile-stack'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useIntegrationToolQuery, useInvokeIntegrationTool } from '@renderer/hooks/use-integration-tools'
import { openExternalUrl } from '@renderer/lib/open-external'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { MEETING_PLATFORM_LABELS, MEETING_PLATFORMS, type MeetingPlatform } from '@shared/lib/meeting-integrations/meeting-url'
import { DEFAULT_MEETING_MODE, isTerminalMeetingStatus, MEETING_MODE_DESCRIPTIONS, MEETING_MODE_LABELS, meetingModeSchema, meetingRecordingLinkSchema, type MeetingMode, type MeetingStatus, type PublicMeeting } from '@shared/lib/meeting-integrations/schemas'
import { Link } from '@tanstack/react-router'
import { MeetingModeSelect } from './meeting-settings-card'

const STATUS_LABELS: Record<MeetingStatus, string> = {
  requested: 'Starting bot', joining: 'Joining', waiting_room: 'In the waiting room', in_call: 'In the call', ended: 'Ended', failed: 'Could not join',
}

/** Service-icon slugs (src/renderer/public/service-icons) for the platforms a bot can join. */
const MEETING_PLATFORM_ICON_SLUGS: Record<MeetingPlatform, string> = { zoom: 'zoom', google_meet: 'googlemeet', microsoft_teams: 'microsoft_teams' }

/** The platforms the agent can be sent into, as the connections-stack treatment the agent home uses. */
function MeetingPlatformsStack() {
  const names = MEETING_PLATFORMS.map(platform => MEETING_PLATFORM_LABELS[platform])
  const label = `Works with ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return <div title={label} role="img" aria-label={label}>
    <TileStack size="sm">
      {MEETING_PLATFORMS.map(platform => <ServiceIcon key={platform} slug={MEETING_PLATFORM_ICON_SLUGS[platform]} fallback="request" className="h-4 w-4" />)}
    </TileStack>
  </div>
}

/** The family's management surface: bring the agent into a call and follow where it is. */
export function MeetingPanel({ integration }: { integration: PublicAgentIntegration }) {
  const urlId = useId()
  const contextId = useId()
  const modeId = useId()
  const [meetingUrl, setMeetingUrl] = useState('')
  const [context, setContext] = useState('')
  // The installation's default mode (which the settings card on the same page may
  // change at any time), overridable for this one call.
  const storedMode = meetingModeSchema.safeParse((integration.settings as { mode?: unknown }).mode)
  const defaultMode: MeetingMode = storedMode.success ? storedMode.data : DEFAULT_MEETING_MODE
  const [chosenMode, setChosenMode] = useState<MeetingMode | null>(null)
  const mode = chosenMode ?? defaultMode
  const [error, setError] = useState<string | null>(null)
  const invoke = useInvokeIntegrationTool<PublicMeeting>(integration.id)
  const meetings = useIntegrationToolQuery<PublicMeeting[]>(integration.id, 'list_meetings', { limit: 10 }, { refetchIntervalMs: 5000 })
  const open = (meetings.data ?? []).filter(meeting => !isTerminalMeetingStatus(meeting.status))
  const past = (meetings.data ?? []).filter(meeting => isTerminalMeetingStatus(meeting.status)).slice(0, 5)

  return (
    <DetailCard label="Meetings" headerActions={<MeetingPlatformsStack />}>
      <form className="space-y-2" onSubmit={async event => {
        event.preventDefault()
        if (invoke.isPending || !meetingUrl.trim()) return
        setError(null)
        try {
          await invoke.mutateAsync({ tool: 'join_meeting', input: { meetingUrl: meetingUrl.trim(), mode, ...(context.trim() ? { context: context.trim() } : {}) } })
          setMeetingUrl(''); setContext(''); setChosenMode(null)
        } catch (err) { setError(err instanceof Error ? err.message : 'Could not join the meeting') }
      }}>
        <label htmlFor={urlId} className="text-xs text-muted-foreground">Invite link</label>
        <Input id={urlId} placeholder="https://meet.google.com/abc-defg-hij" value={meetingUrl} onChange={event => setMeetingUrl(event.target.value)} disabled={invoke.isPending} />
        <label htmlFor={contextId} className="text-xs text-muted-foreground">What should the agent do in this meeting?</label>
        <Textarea id={contextId} rows={2} placeholder="Take notes and answer questions about the Q3 deck." value={context} onChange={event => setContext(event.target.value)} disabled={invoke.isPending} />
        <label htmlFor={modeId} className="text-xs text-muted-foreground">In this meeting</label>
        <MeetingModeSelect id={modeId} value={mode} onChange={setChosenMode} disabled={invoke.isPending} />
        <p className="text-xs text-muted-foreground">{MEETING_MODE_DESCRIPTIONS[mode]}</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button size="sm" type="submit" disabled={invoke.isPending || !meetingUrl.trim()} className="w-full">
          {invoke.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending the agent…</> : <><Video className="h-4 w-4 mr-2" />Join meeting</>}
        </Button>
      </form>
      {open.length > 0 && <ul className="mt-4 space-y-2">
        {open.map(meeting => <MeetingRow key={meeting.id} meeting={meeting} agentSlug={integration.agentSlug} onLeave={async () => {
          try { await invoke.mutateAsync({ tool: 'leave_meeting', input: { meetingId: meeting.id } }) }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not leave the meeting') }
        }} />)}
      </ul>}
      {past.length > 0 && <div className="mt-4">
        <p className="text-xs text-muted-foreground mb-1">Recent</p>
        <ul className="space-y-1">{past.map(meeting => <MeetingRow key={meeting.id} meeting={meeting} agentSlug={integration.agentSlug} onRecording={async () => {
          // Links expire within hours, so one is fetched when asked for and opened straight away.
          try {
            const link = meetingRecordingLinkSchema.nullable().parse(await invoke.mutateAsync({ tool: 'get_meeting_recording', input: { meetingId: meeting.id } }))
            if (!link) { setError('No recording is available for this meeting yet.'); return }
            await openExternalUrl(link.url)
          } catch (err) { setError(err instanceof Error ? err.message : 'Could not fetch the recording') }
        }} />)}</ul>
      </div>}
    </DetailCard>
  )
}

function MeetingRow({ meeting, agentSlug, onLeave, onRecording }: { meeting: PublicMeeting; agentSlug: string; onLeave?: () => void; onRecording?: () => void }) {
  const live = !isTerminalMeetingStatus(meeting.status)
  const recorded = !!meeting.recordingRetainedUntil && meeting.recordingRetainedUntil > Date.now()
  return (
    <li className="flex items-start justify-between gap-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${meeting.status === 'in_call' ? 'bg-green-500' : live ? 'bg-amber-500 animate-pulse' : meeting.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
          <span className="font-medium">{MEETING_PLATFORM_LABELS[meeting.platform]}</span>
          <span className="text-muted-foreground">{STATUS_LABELS[meeting.status]}</span>
          {meeting.mode && meeting.mode !== 'voice' && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{MEETING_MODE_LABELS[meeting.mode]}</span>}
        </div>
        {meeting.statusDetail && live && <p className="text-xs text-muted-foreground truncate">{meeting.statusDetail}</p>}
        {meeting.sessionId && <Link to="/agents/$slug/chat/$integrationId" params={{ slug: agentSlug, integrationId: meeting.integrationId }} search={{ session: meeting.sessionId }} className="text-xs underline text-muted-foreground">Open session</Link>}
      </div>
      {live && onLeave && <Button size="sm" variant="ghost" onClick={onLeave} aria-label="Leave meeting"><LogOut className="h-4 w-4" /></Button>}
      {recorded && onRecording && <Button size="sm" variant="ghost" onClick={onRecording} aria-label="Play recording"><Play className="h-4 w-4" /></Button>}
    </li>
  )
}
