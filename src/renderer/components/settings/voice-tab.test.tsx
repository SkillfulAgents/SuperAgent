// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { VoiceTab } from './voice-tab'

const state = {
  isAuthMode: false,
  isAdmin: true,
  ttsConfigured: true,
  sttProvider: 'deepgram' as string | undefined,
  defaultVoice: undefined as string | undefined,
  userVoice: undefined as { ttsVoice?: string; ttsSpeed?: number } | undefined,
}
const updateSettings = vi.fn()
const updateUserSettings = vi.fn()

vi.mock('@renderer/context/user-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/user-context')>()),
  useUser: () => ({ isAuthMode: state.isAuthMode, isAdmin: state.isAdmin }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      voice: { sttProvider: state.sttProvider, ttsVoice: state.defaultVoice },
      apiKeyStatus: { deepgram: { isConfigured: true, source: 'settings' }, openai: { isConfigured: false, source: 'none' } },
    },
    isLoading: false,
  }),
  useUpdateSettings: () => ({ mutate: updateSettings, mutateAsync: updateSettings }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { voice: state.userVoice }, isLoading: false }),
  useUpdateUserSettings: () => ({ mutate: updateUserSettings }),
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useIsTtsConfigured: () => state.ttsConfigured,
  useVoiceInput: () => ({ state: 'idle', isRecording: false, isConnecting: false, isFinalizing: false, error: null, clearError: vi.fn(), isSupported: false, analyserRef: { current: null }, startRecording: vi.fn(), stopRecording: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-read-aloud', () => ({
  useReadAloud: () => ({ status: 'idle', isActive: false, toggle: vi.fn(), error: null }),
}))
vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: false } }),
}))
vi.mock('@renderer/components/ui/voice-input-button', () => ({
  VoiceInputButton: () => null,
  VoiceInputError: () => null,
}))

describe('VoiceTab', () => {
  beforeEach(() => {
    state.isAuthMode = false
    state.isAdmin = true
    state.ttsConfigured = true
    state.sttProvider = 'deepgram'
    state.defaultVoice = undefined
    state.userVoice = undefined
    updateSettings.mockReset()
    updateUserSettings.mockReset()
  })

  it('a member of a shared deployment sees only their own voice and speed', () => {
    state.isAuthMode = true
    state.isAdmin = false
    renderWithProviders(<VoiceTab />)
    expect(screen.getByTestId('personal-voice-section')).toBeInTheDocument()
    expect(screen.getByText('Your Voice')).toBeInTheDocument()
    expect(screen.getByLabelText('Speed')).toBeInTheDocument()
    expect(screen.queryByLabelText('Provider')).toBeNull()
    expect(screen.queryByTestId('default-voice-section')).toBeNull()
    expect(screen.queryByText('Test')).toBeNull()
  })

  it('tells a member to ask an admin when speech is not set up', () => {
    state.isAuthMode = true
    state.isAdmin = false
    state.ttsConfigured = false
    renderWithProviders(<VoiceTab />)
    expect(screen.getByTestId('voice-unavailable-note')).toBeInTheDocument()
    expect(screen.queryByTestId('personal-voice-section')).toBeNull()
  })

  it('an admin of a shared deployment also gets the provider, key, and default voice', () => {
    state.isAuthMode = true
    state.isAdmin = true
    renderWithProviders(<VoiceTab />)
    expect(screen.getByTestId('personal-voice-section')).toBeInTheDocument()
    expect(screen.getByLabelText('Provider')).toBeInTheDocument()
    expect(screen.getByTestId('default-voice-section')).toBeInTheDocument()
  })

  it('a local install has one person, so there is no separate default voice', () => {
    renderWithProviders(<VoiceTab />)
    expect(screen.getByText('Text-to-Speech')).toBeInTheDocument()
    expect(screen.getByLabelText('Provider')).toBeInTheDocument()
    expect(screen.queryByTestId('default-voice-section')).toBeNull()
  })

  it('shows the deployment default until the user picks, then their own pick and pace', () => {
    state.isAuthMode = true
    state.defaultVoice = 'aura-2-zeus-en'
    const first = renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Zeus')
    expect(screen.getByLabelText('Speed')).toHaveTextContent('Normal')
    first.unmount()

    state.userVoice = { ttsVoice: 'aura-2-luna-en', ttsSpeed: 1.2 }
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Luna')
    expect(screen.getByLabelText('Speed')).toHaveTextContent('1.2×')
  })

  it('a speed off the preset list still renders readably', () => {
    state.userVoice = { ttsSpeed: 1.05 }
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Speed')).toHaveTextContent('1.05×')
  })

  it('writes the personal pick to user settings, not the deployment settings', () => {
    renderWithProviders(<VoiceTab />)
    fireEvent.click(screen.getByLabelText('Voice', { selector: '#tts-voice' }))
    fireEvent.click(screen.getByRole('option', { name: /Luna/ }))
    expect(updateUserSettings).toHaveBeenCalledWith({ voice: { ttsVoice: 'aura-2-luna-en' } })
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
