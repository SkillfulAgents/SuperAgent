import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { getApiBaseUrl } from '@renderer/lib/env'
import { meetingRosterInstruction } from '@shared/lib/meeting-integrations/prompts'
import { DEFAULT_MEETING_MODE, meetingRosterSchema, type MeetingMode, type MeetingRoster } from '@shared/lib/meeting-integrations/schemas'
import { useMessages, useSendMessage } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { MeetingBrowserCard } from './meeting-browser-card'
import { useMeetingSpeechRelay } from './use-meeting-speech-relay'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { describeWorkspaceFile, type WorkspaceFile } from '@renderer/lib/workspace-file'
import { deliverFileDef } from '@shared/lib/tools/deliver-file/definition'
import { useVoiceMode } from '@renderer/hooks/use-voice-mode'
import { useVoiceConversationProblem } from '@renderer/hooks/use-voice-input'
import { VoiceOrb } from '@renderer/components/messages/voice-orb'
import { AgentCallOrb, callOrbState } from '@renderer/components/messages/agent-call-orb'
import { VoiceBars } from '@renderer/components/messages/voice-bars'
import { cn } from '@shared/lib/utils'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { boundVoiceHistoryTransport } from '@shared/lib/voice/voice-history-transport'
import type { PublicMeeting } from '@shared/lib/meeting-integrations/schemas'
import type { DotOrbState } from '@renderer/lib/voice/orb/dot-orb'

interface ParticipantBootstrap {
  meeting: PublicMeeting
  agentSlug: string
  agentName: string
  /** Null when the agent's row is gone; the page falls back to the dot orb. */
  agentAvatar?: AgentAvatar | null
  sessionId: string
}

class BootstrapError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) { super(message) }
}

async function fetchBootstrap(meetingId: string, token: string): Promise<ParticipantBootstrap> {
  const response = await apiFetch(`/api/meeting-participant/${encodeURIComponent(meetingId)}?token=${encodeURIComponent(token)}`)
  const payload = await response.json().catch(() => null) as (ParticipantBootstrap & { error?: string; retryAfterMs?: number }) | null
  if (!response.ok) throw new BootstrapError(payload?.error ?? 'Could not load the meeting', response.status, payload?.retryAfterMs)
  return payload as ParticipantBootstrap
}

/**
 * What the meeting bot shows as its camera and runs as its ears and voice.
 *
 * This is the app's own voice mode pointed at the meeting's agent session:
 * the bot's browser hands the room's audio to `getUserMedia` and plays what
 * this page plays into the call. The page renders at 1280x720 and never
 * shows app chrome. How much it shows and whether it plays anything is the
 * meeting's mode: a voice participant, a silent one whose replies are
 * written, or a listener that gives the room nothing.
 */
export function MeetingParticipantPage({ meetingId, token }: { meetingId: string; token: string }) {
  const bootstrap = useQuery({
    queryKey: ['meeting-participant', meetingId, token],
    queryFn: () => fetchBootstrap(meetingId, token),
    enabled: !!token,
    // Not-ready answers (503) are expected for a few seconds while the agent session starts.
    retry: (count, error) => error instanceof BootstrapError ? error.status === 503 && count < 60 : count < 3,
    retryDelay: (_count, error) => (error instanceof BootstrapError && error.retryAfterMs) || 2000,
    staleTime: Infinity,
  })
  // The page is only ever shown in the bot's browser: pin a dark stage.
  useEffect(() => {
    document.documentElement.classList.add('dark')
    document.body.style.background = '#000'
    return () => { document.body.style.background = '' }
  }, [])

  if (!token) return <Stage title="Missing participant token" />
  if (bootstrap.isError) return <Stage title={bootstrap.error instanceof Error ? bootstrap.error.message : 'Could not load the meeting'} />
  if (!bootstrap.data) return <Stage title="Getting ready…" />
  return <Participant {...bootstrap.data} token={token} />
}

const EMPTY_ROSTER: MeetingRoster = { participants: [], speaking: [] }

/** The room's roster as the bot host reports it, over the participant stream. */
function useMeetingRoster(meetingId: string, token: string): MeetingRoster {
  const [roster, setRoster] = useState(EMPTY_ROSTER)
  useEffect(() => {
    const source = new EventSource(`${getApiBaseUrl()}/api/meeting-participant/${encodeURIComponent(meetingId)}/stream?token=${encodeURIComponent(token)}`)
    source.addEventListener('roster', (event) => {
      let payload: unknown
      try { payload = JSON.parse((event as MessageEvent).data) } catch { return }
      const parsed = meetingRosterSchema.safeParse(payload)
      if (parsed.success) setRoster(parsed.data)
    })
    return () => source.close()
  }, [meetingId, token])
  return roster
}

function Participant({ agentSlug, agentAvatar, sessionId, meeting, token }: ParticipantBootstrap & { token: string }) {
  const mode: MeetingMode = meeting.mode ?? DEFAULT_MEETING_MODE
  const spoken = mode === 'voice'
  const { data: messages } = useMessages(sessionId, agentSlug)
  // The session's browser, when open, takes the camera the way the tray takes the chat.
  const { browserActive, isActive } = useMessageStream(sessionId, agentSlug, ['browserActive', 'isActive'])
  const roster = useMeetingRoster(meeting.id, token)
  const send = useSendMessage({ quiet: true })
  const [sendError, setSendError] = useState<string | null>(null)
  // Startup context for the voice model: the brief and anything the agent has said since.
  const history = useMemo(() => boundVoiceHistoryTransport((messages ?? []).flatMap(message =>
    (message.type === 'user' || message.type === 'assistant') && message.content.text.trim()
      ? [{ role: message.type, content: message.content.text }]
      : [],
  )), [messages])
  const image = useMemo(() => latestDeliveredImage(messages ?? [], agentSlug), [messages, agentSlug])
  // The call's speech, heard and said aloud, goes to the host for the meeting's transcript file, in every mode.
  const relaySpeech = useMeetingSpeechRelay(meeting.id, token)
  const voice = useVoiceMode({
    sessionId,
    agentSlug,
    active: true,
    history,
    onSpeech: relaySpeech,
    send: async (text) => {
      try { await send.mutateAsync({ sessionId, agentSlug, content: text }); setSendError(null); return true }
      catch (error) { setSendError(error instanceof Error ? error.message : 'Could not reach the agent'); return false }
    },
  })
  // Voice mode does not start without an engine, and says nothing about it; here
  // that would leave the tile on "Connecting…" for the whole call.
  const voiceProblem = useVoiceConversationProblem()
  const fault = voiceProblem ?? voice.error ?? sendError
  // A silent or listening bot plays nothing into the call, whatever the voice model does.
  // The mute is per engine run, so it is applied again after every reconnect.
  const setOutputMuted = voice.setOutputMuted
  useEffect(() => { if (voice.ready) setOutputMuted(!spoken) }, [voice.ready, spoken, setOutputMuted])
  // Tell the voice model who is in the room whenever that changes, and again
  // after a reconnect (the host also puts the roster in the prompt at mint time,
  // so this only has to cover changes during one engine run).
  const briefed = useRef<string | null>(null)
  const participantsKey = roster.participants.map(person => `${person.id}:${person.name}:${person.isHost}`).join('|')
  const instruct = voice.instruct
  useEffect(() => {
    if (!voice.ready) { briefed.current = null; return }
    if (briefed.current === participantsKey) return
    briefed.current = participantsKey
    instruct(meetingRosterInstruction(roster.participants, mode))
    // roster.participants is fully described by participantsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.ready, participantsKey, instruct, mode])

  if (mode === 'listen') {
    // The room gets nothing: no orb, no words, no browser, no roster. The
    // engine still runs as the agent's ears; a fault is the one thing shown.
    return <Stage subtitle="Listening in" error={fault} />
  }

  const speaking = spoken && (voice.assistantSpeaking || voice.phase === 'speaking')
  const thinking = voice.working || voice.phase === 'thinking'
  const caption = voiceProblem ? 'Voice unavailable'
    : !voice.ready ? 'Connecting…'
    : voice.working ? 'Working on it'
    : speaking ? 'Speaking'
    : spoken ? 'Listening' : 'Silent'
  // Subtitles are the agent's own words only. Spoken: its utterance while it is
  // the latest thing said. Silent: its latest written reply, which the
  // integration also posts into the call's chat.
  const latest = voice.transcript?.at(-1)
  const subtitle = spoken ? (latest?.role === 'assistant' ? latest.text : null) : latestWrittenReply(messages ?? [])
  // The state, small, tucked under the orb's bars (or the dot orb itself).
  const status = (size: number) => (
    <p className="text-center text-white/50" style={{ fontSize: Math.round(size * 0.075), marginTop: size * 0.06 }} data-testid="meeting-status">{caption}</p>
  )
  const orb = (size: number) => {
    if (agentAvatar) {
      // The iOS call screen's orb and bars, sized to the camera: the room is the person's row.
      return (
        <div className="flex flex-col items-center">
          <AgentCallOrb agent={{ slug: agentSlug, avatar: agentAvatar }} state={callOrbState({ ready: voice.ready, busy: speaking || thinking })} size={size} />
          <div style={{ height: size * 0.12 }} />
          <VoiceBars
            agentColor={avatarSource(agentAvatar).orb.core}
            getAgentAnalyser={voice.getOutputAnalyser}
            getPersonAnalyser={voice.getAnalyser}
            agentSpeaking={speaking}
            personMuted={false}
            scale={size / 120}
            className={cn('text-white transition-opacity duration-300', voice.ready ? 'opacity-100' : 'opacity-0')}
          />
          {status(size)}
        </div>
      )
    }
    const orbState: DotOrbState = !voice.ready ? 'boot'
      : speaking ? 'agent'
      : voice.userSpeaking ? 'user'
      : thinking ? 'thinking'
      : 'ready'
    return (
      <div className="flex flex-col items-center">
        <VoiceOrb state={orbState} size={size} monochrome={!voice.ready} getAnalyser={() => orbState === 'agent' ? voice.getOutputAnalyser() : voice.getAnalyser()} />
        {status(size)}
      </div>
    )
  }
  // What shares the camera with the orb: the live browser while it is open,
  // else the latest delivered image, else nothing.
  return (
    // No name or roster: the call's own tile label already names the bot, and
    // its people are on the tiles around it. The state sits under the orb.
    <Stage error={fault} compact={browserActive || !!image} centered={!browserActive && !image} footer={<Subtitles text={subtitle} />}>
      {browserActive ? (
        <div className="flex items-center gap-10">
          <MeetingBrowserCard agentSlug={agentSlug} sessionId={sessionId} isActive={isActive} width={760} />
          {orb(160)}
        </div>
      ) : image ? (
        <div className="flex items-center gap-10">
          <img key={image.inlineUrl} src={image.inlineUrl ?? undefined} alt={image.name} className="max-h-[380px] max-w-[760px] rounded-xl object-contain shadow-2xl" data-testid="meeting-image" />
          {orb(160)}
        </div>
      ) : orb(240)}
    </Stage>
  )
}

/** The agent's most recent written words in the session, for a silent bot's subtitles. */
function latestWrittenReply(messages: ApiMessageOrBoundary[]): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (message.type === 'assistant' && message.content.text.trim()) return message.content.text.trim()
  }
  return null
}

/**
 * The most recent image the agent handed over with deliver_file. It stays on
 * the camera until the next delivered image replaces it; other file types are
 * shared through the meeting chat by the integration instead.
 */
function latestDeliveredImage(messages: ApiMessageOrBoundary[], agentSlug: string): WorkspaceFile | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (message.type !== 'assistant') continue
    for (let c = message.toolCalls.length - 1; c >= 0; c--) {
      const call = message.toolCalls[c]
      if (call.name !== 'mcp__user-input__deliver_file' || call.isError || call.result == null) continue
      const { filePath } = deliverFileDef.parseInput(call.input)
      if (!filePath) continue
      const file = describeWorkspaceFile(filePath, agentSlug)
      if (file.isImage && file.inlineUrl) return file
    }
  }
  return null
}

/** Up to two lines of the agent's speech, bottom-anchored so new words roll older ones out the top. */
function Subtitles({ text }: { text: string | null }) {
  return (
    <div className="flex h-16 w-full max-w-3xl flex-col justify-end overflow-hidden px-6" aria-live="polite" data-testid="meeting-subtitles">
      {text && <p className="text-center text-2xl leading-8 break-words text-white/70">{text}</p>}
    </div>
  )
}

/**
 * The 1280x720 camera frame: whatever the agent is showing fills the middle,
 * and the caption block (title, state, error, subtitles) sits in a footer of
 * its own. Centered, the middle is the whole frame and the footer lies over
 * its bottom, so the orb sits at the true center of the tile. Otherwise the
 * footer is in the flow, so a tall visual compresses the gap above it instead
 * of sliding under the subtitles; it shrinks when a visual is up so the two
 * never fight for the same rows.
 */
function Stage({ title, subtitle, error, compact = false, centered = false, footer, children }: {
  title?: string
  subtitle?: string
  error?: string | null
  compact?: boolean
  centered?: boolean
  footer?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <main className="dark relative flex h-screen w-screen flex-col items-center bg-black text-white" data-testid="meeting-participant">
      <div className={cn('flex min-h-0 w-full flex-col items-center justify-center gap-4', centered ? 'absolute inset-0' : 'flex-1')}>
        {children}
      </div>
      <div className={cn('flex shrink-0 flex-col items-center text-center', compact ? 'pb-4' : 'pb-8', centered && 'absolute inset-x-0 bottom-0')}>
        {title && <h1 className={compact ? 'text-2xl font-medium tracking-tight' : 'text-4xl font-medium tracking-tight'}>{title}</h1>}
        {subtitle && <p className={cn(compact ? 'text-lg text-white/60' : 'text-2xl text-white/60', title && (compact ? 'mt-1' : 'mt-2'))}>{subtitle}</p>}
        {error && <p role="alert" className={compact ? 'mt-1 text-base text-red-400' : 'mt-3 text-lg text-red-400'}>{error}</p>}
        {footer}
      </div>
    </main>
  )
}
