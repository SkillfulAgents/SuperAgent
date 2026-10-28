// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MeetingSettingsCard } from './meeting-settings-card'
import { makeChatIntegration } from './test-factories'

const LIVE_VOICES = [{ id: 'marin', label: 'Marin', description: 'English' }, { id: 'cinder', label: 'Cinder', description: 'Southern U.S. English' }]
const state = vi.hoisted(() => ({ mutate: vi.fn(), isSuccess: false, voices: [] as Array<{ id: string; label: string; description: string }> }))
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useUpdateAgentIntegration: () => ({ mutate: state.mutate, isPending: false, isError: false, isSuccess: state.isSuccess, error: null }),
}))
// The host reports the Live voices of whatever provider is configured; the card knows no catalog.
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useLiveVoices: () => ({ voices: state.voices, defaultVoice: 'marin' }),
}))

beforeEach(() => { vi.clearAllMocks(); state.isSuccess = false; state.voices = LIVE_VOICES })
afterEach(cleanup)
const integration = (settings: Record<string, unknown> = { botName: 'Ada', instructions: 'Keep it short.', mode: 'silent', voice: 'cinder' }) =>
  makeChatIntegration({ provider: 'recall' as never, settings: settings as never })

it('shows the stored name, mode, voice and standing instructions and saves only once something changed', async () => {
  render(<MeetingSettingsCard integration={integration()} />)
  expect(screen.getByLabelText(/name in calls/i)).toHaveValue('Ada')
  expect(screen.getByLabelText(/instructions for every meeting/i)).toHaveValue('Keep it short.')
  expect(screen.getByLabelText(/in meetings/i)).toHaveTextContent('Silent')
  expect(screen.getByText(/Never speaks\. Replies go into the meeting chat/)).toBeInTheDocument()
  expect(screen.getByLabelText(/^voice$/i)).toHaveTextContent('Cinder(Southern U.S. English)')
  const save = screen.getByRole('button', { name: /save meeting settings/i })
  expect(save).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/instructions for every meeting/i), ' Track action items.')
  await userEvent.click(save)
  expect(state.mutate).toHaveBeenCalledWith({ id: 'int-1', config: { botName: 'Ada', instructions: 'Keep it short. Track action items.', mode: 'silent', voice: 'cinder' } })
})

it('reads a bare installation as speaking with the default voice, and clears a field by sending null for it', async () => {
  render(<MeetingSettingsCard integration={integration({ botName: 'Ada', instructions: 'Keep it short.' })} />)
  expect(screen.getByLabelText(/in meetings/i)).toHaveTextContent('Speaks')
  expect(screen.getByLabelText(/^voice$/i)).toHaveTextContent('Default (Marin)')
  await userEvent.clear(screen.getByLabelText(/instructions for every meeting/i))
  await userEvent.click(screen.getByRole('button', { name: /save meeting settings/i }))
  expect(state.mutate).toHaveBeenCalledWith({ id: 'int-1', config: { botName: 'Ada', instructions: null, mode: 'voice', voice: null } })
})

it('keeps the stored voice when the voice list arrives after the card mounted', async () => {
  state.voices = []
  const { rerender } = render(<MeetingSettingsCard integration={integration()} />)
  expect(screen.queryByLabelText(/^voice$/i)).toBeNull()
  state.voices = LIVE_VOICES
  rerender(<MeetingSettingsCard integration={integration()} />)
  expect(screen.getByLabelText(/^voice$/i)).toHaveTextContent('Cinder')
  expect(screen.getByRole('button', { name: /save meeting settings/i })).toBeDisabled()
  // A save for an unrelated change still carries the stored voice rather than clearing it.
  await userEvent.type(screen.getByLabelText(/name in calls/i), ' Lovelace')
  await userEvent.click(screen.getByRole('button', { name: /save meeting settings/i }))
  expect(state.mutate).toHaveBeenCalledWith({ id: 'int-1', config: expect.objectContaining({ botName: 'Ada Lovelace', voice: 'cinder' }) })
})

it('confirms a save once the stored settings match the form', () => {
  state.isSuccess = true
  render(<MeetingSettingsCard integration={integration()} />)
  expect(screen.getByRole('status')).toHaveTextContent(/saved/i)
})
