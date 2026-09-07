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
const VOICES = [
  { id: 'aura-2-thalia-en', label: 'Thalia', description: 'Clear' },
  { id: 'aura-2-luna-en', label: 'Luna', description: 'Friendly' },
  { id: 'aura-2-zeus-en', label: 'Zeus', description: 'Deep' },
]
const updateSettings = vi.fn()
const updateUserSettings = vi.fn()
const useSettingsCalls: ({ enabled?: boolean } | undefined)[] = []

vi.mock('@renderer/context/user-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/user-context')>()),
  useUser: () => ({ isAuthMode: state.isAuthMode, isAdmin: state.isAdmin }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: (options?: { enabled?: boolean }) => {
    useSettingsCalls.push(options)
    if (options?.enabled === false) return { data: undefined, isLoading: false }
    return {
      data: {
        voice: { sttProvider: state.sttProvider, ttsVoice: state.defaultVoice },
        apiKeyStatus: { deepgram: { isConfigured: true, source: 'settings' }, openai: { isConfigured: false, source: 'none' } },
      },
      isLoading: false,
    }
  },
  useUpdateSettings: () => ({ mutate: updateSettings, mutateAsync: updateSettings }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { voice: state.userVoice }, isLoading: false }),
  useUpdateUserSettings: () => ({ mutate: updateUserSettings }),
}))
vi.mock('@renderer/hooks/use-voice-input', () => ({
  useIsTtsConfigured: () => state.ttsConfigured,
  // What the member-readable endpoint reports: the provider's voices and the
  // deployment default among them.
  useTtsVoices: () => ({ voices: VOICES, defaultVoice: state.defaultVoice ?? 'aura-2-thalia-en' }),
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
    useSettingsCalls.length = 0
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
    // The settings endpoint is admin-only: a member's tab must never request it.
    expect(useSettingsCalls.length).toBeGreaterThan(0)
    expect(useSettingsCalls.every((o) => o?.enabled === false)).toBe(true)
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

  it('shows the workspace default until the user picks, then their own pick and pace', () => {
    state.isAuthMode = true
    state.isAdmin = false
    state.defaultVoice = 'aura-2-zeus-en'
    const first = renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Workspace Default (Zeus)')
    expect(screen.getByLabelText('Speed')).toHaveTextContent('Normal')
    first.unmount()

    state.userVoice = { ttsVoice: 'aura-2-luna-en', ttsSpeed: 1.2 }
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Luna')
    expect(screen.getByLabelText('Speed')).toHaveTextContent('1.2×')
  })

  it('picking the workspace default again unsets the personal voice', () => {
    state.isAuthMode = true
    state.isAdmin = false
    state.defaultVoice = 'aura-2-zeus-en'
    state.userVoice = { ttsVoice: 'aura-2-luna-en' }
    renderWithProviders(<VoiceTab />)
    fireEvent.click(screen.getByLabelText('Voice', { selector: '#tts-voice' }))
    fireEvent.click(screen.getByRole('option', { name: /Workspace Default \(Zeus\)/ }))
    expect(updateUserSettings).toHaveBeenCalledWith({ voice: { ttsVoice: null } })
  })

  it('a local install offers no workspace default: there is nobody else to follow', () => {
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Thalia')
    fireEvent.click(screen.getByLabelText('Voice', { selector: '#tts-voice' }))
    expect(screen.queryByRole('option', { name: /Workspace Default/ })).toBeNull()
  })

  it('a speed off the preset list still renders readably', () => {
    state.userVoice = { ttsSpeed: 1.05 }
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Speed')).toHaveTextContent('1.05×')
  })

  it('a stored pick the provider no longer offers reads as no pick', () => {
    state.isAuthMode = true
    state.isAdmin = false
    state.defaultVoice = 'aura-2-zeus-en'
    state.userVoice = { ttsVoice: 'aura-retired-en' }
    renderWithProviders(<VoiceTab />)
    expect(screen.getByLabelText('Voice', { selector: '#tts-voice' })).toHaveTextContent('Workspace Default (Zeus)')
  })

  it('writes the personal pick to user settings, not the deployment settings', () => {
    renderWithProviders(<VoiceTab />)
    fireEvent.click(screen.getByLabelText('Voice', { selector: '#tts-voice' }))
    fireEvent.click(screen.getByRole('option', { name: /Luna/ }))
    expect(updateUserSettings).toHaveBeenCalledWith({ voice: { ttsVoice: 'aura-2-luna-en' } })
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
