// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'

// The page is the bot's camera: what it shows depends on the voice engine's
// state, the session's browser, and the latest delivered image. Everything
// behind those is mocked at the hook boundary; the layout is what is tested.
const state = vi.hoisted(() => ({
  bootstrap: { ok: true, status: 200, body: { meeting: { id: 'm1', botName: 'Ada (Gamut)', platform: 'zoom' }, agentSlug: 'research', agentName: 'Ada', sessionId: 's1' } as unknown },
  voice: { ready: true, phase: 'listening', assistantSpeaking: false, userSpeaking: false, working: false, error: null as string | null, transcript: [] as Array<{ role: string; text: string }> },
  voiceProblem: null as string | null,
  browserActive: false,
  messages: [] as unknown[],
  instruct: vi.fn(),
  setOutputMuted: vi.fn(),
  voiceArgs: [] as unknown[],
  sources: [] as Array<{ url: string; listeners: Map<string, (event: { data: string }) => void>; close: () => void }>,
}))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async () => ({ ok: state.bootstrap.ok, status: state.bootstrap.status, json: async () => state.bootstrap.body })),
}))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => '' }))
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: state.messages }),
  useSendMessage: () => ({ mutateAsync: vi.fn(async () => {}) }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ browserActive: state.browserActive, isActive: state.browserActive }) }))
vi.mock('@renderer/hooks/use-voice-mode', () => ({
  useVoiceMode: (args: unknown) => { state.voiceArgs.push(args); return { ...state.voice, instruct: state.instruct, setOutputMuted: state.setOutputMuted, getAnalyser: () => null, getOutputAnalyser: () => null } },
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({ useVoiceConversationProblem: () => state.voiceProblem }))
vi.mock('@renderer/components/messages/voice-orb', () => ({ VoiceOrb: ({ size, state: orbState }: { size: number; state: string }) => <div data-testid="orb" data-size={size} data-state={orbState} /> }))
vi.mock('./meeting-browser-card', () => ({ MeetingBrowserCard: ({ width }: { width: number }) => <div data-testid="meeting-browser" data-width={width} /> }))
vi.mock('@renderer/lib/workspace-file', () => ({
  describeWorkspaceFile: (filePath: string) => ({ name: filePath.split('/').pop(), isImage: /\.png$/.test(filePath), inlineUrl: /\.png$/.test(filePath) ? `/files/${filePath}` : null }),
}))

class FakeEventSource {
  listeners = new Map<string, (event: { data: string }) => void>()
  constructor(readonly url: string) { state.sources.push(this) }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener) }
  close = vi.fn()
}
vi.stubGlobal('EventSource', FakeEventSource)

import { MeetingParticipantPage } from './meeting-participant-page'

const deliveredImage = (filePath: string) => ({
  type: 'assistant', content: { text: '' },
  toolCalls: [{ name: 'mcp__user-input__deliver_file', input: { filePath }, result: 'ok', isError: false }],
})

beforeEach(() => {
  vi.clearAllMocks()
  state.sources.length = 0
  state.voiceArgs.length = 0
  state.voiceProblem = null
  state.browserActive = false
  state.messages = []
  state.voice = { ready: true, phase: 'listening', assistantSpeaking: false, userSpeaking: false, working: false, error: null, transcript: [] }
  state.bootstrap = { ok: true, status: 200, body: { meeting: { id: 'm1', botName: 'Ada (Gamut)', platform: 'zoom' }, agentSlug: 'research', agentName: 'Ada', sessionId: 's1' } }
})

describe('MeetingParticipantPage', () => {
  it('asks for the token and names a refused meeting', async () => {
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="" />)
    expect(screen.getByText('Missing participant token')).toBeInTheDocument()
    state.bootstrap = { ok: false, status: 410, body: { error: 'This meeting has ended' } }
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByText('This meeting has ended')).toBeInTheDocument())
  })

  it('shows the big orb alone with the name, state and roster in the footer', async () => {
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument())
    expect(screen.getByText('Ada (Gamut) · Listening')).toBeInTheDocument()
    expect(screen.getByTestId('orb')).toHaveAttribute('data-size', '300')
    expect(screen.queryByTestId('meeting-roster')).not.toBeInTheDocument()
    // The roster arrives over the participant stream and is relayed to the voice model.
    const source = state.sources.find(entry => entry.url.includes('/api/meeting-participant/m1/stream'))!
    source.listeners.get('roster')!({ data: JSON.stringify({ participants: [{ id: '1', name: 'Iddo', isHost: true }, { id: '2', name: 'Maya', isHost: false }], speaking: ['2'] }) })
    await waitFor(() => expect(screen.getByTestId('meeting-roster')).toHaveTextContent('In the call: Iddo, Maya'))
    expect(state.instruct).toHaveBeenLastCalledWith(expect.stringContaining('in the call now: Iddo (host), Maya'))
  })

  it('puts the live browser beside a small orb while the agent browses', async () => {
    state.browserActive = true
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByTestId('meeting-browser')).toHaveAttribute('data-width', '760'))
    expect(screen.getByTestId('orb')).toHaveAttribute('data-size', '160')
    expect(screen.queryByTestId('meeting-image')).not.toBeInTheDocument()
  })

  it('shows the latest delivered image otherwise, and the agent words as subtitles', async () => {
    state.messages = [deliveredImage('/workspace/output/old.png'), deliveredImage('/workspace/notes.md'), deliveredImage('/workspace/output/chart.png')]
    state.voice.transcript = [{ role: 'user', text: 'show me' }, { role: 'assistant', text: 'Here is the Q3 chart.' }]
    state.voice.assistantSpeaking = true
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByTestId('meeting-image')).toHaveAttribute('src', '/files//workspace/output/chart.png'))
    expect(screen.getByTestId('orb')).toHaveAttribute('data-state', 'agent')
    expect(screen.getByTestId('meeting-subtitles')).toHaveTextContent('Here is the Q3 chart.')
    expect(screen.getByText('Ada (Gamut) · Speaking')).toBeInTheDocument()
  })

  it('runs the voice engine on the meeting session with the call audio unmuted for a speaking bot', async () => {
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument())
    expect(state.voiceArgs.at(-1)).toMatchObject({ sessionId: 's1', agentSlug: 'research', active: true })
    expect(state.setOutputMuted).toHaveBeenLastCalledWith(false)
  })

  it('silent: mutes the call audio, captions the bot as silent and subtitles its written reply', async () => {
    state.bootstrap.body = { ...(state.bootstrap.body as object), meeting: { id: 'm1', botName: 'Ada (Gamut)', platform: 'zoom', mode: 'silent' } }
    state.messages = [{ type: 'assistant', content: { text: 'Q3 revenue was 4.2M.' }, toolCalls: [] }]
    state.voice.transcript = [{ role: 'assistant', text: 'spoken words that nobody hears' }]
    state.voice.assistantSpeaking = true
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByText('Ada (Gamut) · Silent')).toBeInTheDocument())
    expect(state.setOutputMuted).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('meeting-subtitles')).toHaveTextContent('Q3 revenue was 4.2M.')
    expect(screen.getByTestId('orb')).not.toHaveAttribute('data-state', 'agent')
    const source = state.sources.find(entry => entry.url.includes('/api/meeting-participant/m1/stream'))!
    source.listeners.get('roster')!({ data: JSON.stringify({ participants: [{ id: '1', name: 'Iddo', isHost: true }], speaking: [] }) })
    await waitFor(() => expect(state.instruct).toHaveBeenLastCalledWith(expect.stringContaining('You never speak')))
  })

  it('listen: shows the name alone, no orb, words, browser or roster, and mutes the call audio', async () => {
    state.bootstrap.body = { ...(state.bootstrap.body as object), meeting: { id: 'm1', botName: 'Ada (Gamut)', platform: 'zoom', mode: 'listen' } }
    state.browserActive = true
    state.messages = [deliveredImage('/workspace/output/chart.png'), { type: 'assistant', content: { text: 'Fact check: wrong figure.' }, toolCalls: [] }]
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByText('Ada (Gamut) · Listening in')).toBeInTheDocument())
    expect(state.setOutputMuted).toHaveBeenLastCalledWith(true)
    expect(screen.queryByTestId('orb')).not.toBeInTheDocument()
    expect(screen.queryByTestId('meeting-browser')).not.toBeInTheDocument()
    expect(screen.queryByTestId('meeting-subtitles')).not.toBeInTheDocument()
    const source = state.sources.find(entry => entry.url.includes('/api/meeting-participant/m1/stream'))!
    source.listeners.get('roster')!({ data: JSON.stringify({ participants: [{ id: '1', name: 'Iddo', isHost: true }], speaking: [] }) })
    await waitFor(() => expect(state.instruct).toHaveBeenCalled())
    expect(screen.queryByTestId('meeting-roster')).not.toBeInTheDocument()
  })

  it('surfaces a voice error in the footer and shows the orb booting before the engine is ready', async () => {
    state.voice.ready = false
    state.voice.error = 'Voice mapping failed. Please try again.'
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Voice mapping failed. Please try again.'))
    expect(screen.getByTestId('orb')).toHaveAttribute('data-state', 'boot')
    expect(screen.getByText('Ada (Gamut) · Connecting…')).toBeInTheDocument()
  })

  it('names why the voice engine cannot start instead of connecting for the whole call', async () => {
    state.voice.ready = false
    state.voiceProblem = 'Voice settings could not be loaded (401).'
    renderWithProviders(<MeetingParticipantPage meetingId="m1" token="t" />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Voice settings could not be loaded (401).'))
    expect(screen.getByText('Ada (Gamut) · Voice unavailable')).toBeInTheDocument()
  })
})
