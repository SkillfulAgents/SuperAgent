// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MeetingPanel } from './meeting-panel'
import { makeChatIntegration } from './test-factories'

const state = vi.hoisted(() => ({ invoke: vi.fn(), openExternal: vi.fn(async () => {}), meetings: [] as unknown[] }))
vi.mock('@renderer/hooks/use-integration-tools', () => ({
  useInvokeIntegrationTool: () => ({ mutateAsync: state.invoke, isPending: false }),
  useIntegrationToolQuery: () => ({ data: state.meetings }),
}))
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl: state.openExternal }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))

beforeEach(() => { vi.clearAllMocks(); state.meetings = []; state.invoke.mockResolvedValue({}) })
afterEach(cleanup)
const integration = (settings: Record<string, unknown> = {}) => makeChatIntegration({ provider: 'recall' as never, agentSlug: 'agent', settings: settings as never })

it('joins with the installation\'s mode unless changed for this call', async () => {
  render(<MeetingPanel integration={integration({ mode: 'silent' })} />)
  expect(screen.getByRole('combobox', { name: /in this meeting/i })).toHaveTextContent('Silent')
  await userEvent.type(screen.getByLabelText(/invite link/i), 'https://meet.google.com/abc-defg-hij')
  await userEvent.type(screen.getByLabelText(/what should the agent do/i), 'Take notes')
  await userEvent.click(screen.getByRole('button', { name: /join meeting/i }))
  expect(state.invoke).toHaveBeenCalledWith({ tool: 'join_meeting', input: { meetingUrl: 'https://meet.google.com/abc-defg-hij', mode: 'silent', context: 'Take notes' } })
})

it('defaults a bare installation to speaking and labels meetings that run otherwise', () => {
  state.meetings = [
    { id: 'm1', integrationId: 'int-1', meetingUrl: 'https://zoom.us/j/1', platform: 'zoom', status: 'in_call', statusDetail: null, botName: 'Ada', mode: 'listen', sessionId: 's1', context: null, requestedAt: 1, joinedAt: 2, endedAt: null, recordingRetainedUntil: null },
    { id: 'm2', integrationId: 'int-1', meetingUrl: 'https://meet.google.com/a', platform: 'google_meet', status: 'ended', statusDetail: null, botName: 'Ada', mode: 'voice', sessionId: 's2', context: null, requestedAt: 1, joinedAt: 2, endedAt: 3, recordingRetainedUntil: null },
  ]
  render(<MeetingPanel integration={integration()} />)
  expect(screen.getByRole('combobox', { name: /in this meeting/i })).toHaveTextContent('Speaks')
  // The badge sits in the meeting row; the select's own option text does not count.
  expect(screen.getByText('Listens in', { selector: 'li span' })).toBeInTheDocument()
  expect(screen.queryByText('Speaks', { selector: 'li span' })).not.toBeInTheDocument()
})

it('follows a default mode saved on the same page until a mode is picked for this call', () => {
  const { rerender } = render(<MeetingPanel integration={integration()} />)
  expect(screen.getByRole('combobox', { name: /in this meeting/i })).toHaveTextContent('Speaks')
  rerender(<MeetingPanel integration={integration({ mode: 'listen' })} />)
  expect(screen.getByRole('combobox', { name: /in this meeting/i })).toHaveTextContent('Listens in')
})

it('fetches a recording link when asked and opens it outside the app', async () => {
  state.meetings = [
    { id: 'm2', integrationId: 'int-1', meetingUrl: 'https://meet.google.com/a', platform: 'google_meet', status: 'ended', statusDetail: null, botName: 'Ada', mode: 'voice', sessionId: 's2', context: null, requestedAt: 1, joinedAt: 2, endedAt: 3, recordingRetainedUntil: Date.now() + 60_000 },
  ]
  state.invoke.mockResolvedValueOnce({ url: 'https://cdn.example/m2.mp4', linkExpiresAt: null })
  render(<MeetingPanel integration={integration()} />)
  await userEvent.click(screen.getByRole('button', { name: /play recording/i }))
  expect(state.invoke).toHaveBeenCalledWith({ tool: 'get_meeting_recording', input: { meetingId: 'm2' } })
  expect(state.openExternal).toHaveBeenCalledWith('https://cdn.example/m2.mp4')
  state.invoke.mockResolvedValueOnce(null)
  await userEvent.click(screen.getByRole('button', { name: /play recording/i }))
  expect(screen.getByRole('alert')).toHaveTextContent(/no recording is available/i)
  expect(state.openExternal).toHaveBeenCalledTimes(1)
})
