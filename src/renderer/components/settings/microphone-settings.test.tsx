// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { MicrophoneSettings } from './microphone-settings'

const enumerateDevices = vi.fn()
const getUserMedia = vi.fn()
const addEventListener = vi.fn()
const removeEventListener = vi.fn()

function installMediaDevices() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices, getUserMedia, addEventListener, removeEventListener },
  })
}

describe('MicrophoneSettings', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    localStorage.clear()
    enumerateDevices.mockReset()
    getUserMedia.mockReset()
    addEventListener.mockReset()
    removeEventListener.mockReset()
    enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'built-in', label: 'MacBook Microphone' },
      { kind: 'audioinput', deviceId: 'studio-mic', label: 'Studio Mic' },
    ])
    installMediaDevices()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists microphones and saves the selected input on this device', async () => {
    renderWithProviders(<MicrophoneSettings />)

    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeInTheDocument()
    const picker = screen.getByLabelText('Input device')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'Studio Mic' }))

    expect(localStorage.getItem('voice.microphoneDeviceId')).toBe('studio-mic')
    expect(picker).toHaveTextContent('Studio Mic')
  })

  it('keeps a saved disconnected microphone visible while captures fall back', async () => {
    localStorage.setItem('voice.microphoneDeviceId', 'travel-mic')
    renderWithProviders(<MicrophoneSettings />)

    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
    expect(screen.getByLabelText('Input device')).toHaveTextContent('Saved microphone (not currently listed)')
    expect(screen.getByText(/system default will be used if it cannot be opened/i)).toBeInTheDocument()
  })

  it('tests the selected microphone and releases it when stopped', async () => {
    localStorage.setItem('voice.microphoneDeviceId', 'studio-mic')
    const stop = vi.fn()
    const stream = {
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'studio-mic' }) }],
    } as unknown as MediaStream
    getUserMedia.mockResolvedValue(stream)
    const disconnect = vi.fn()
    const close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', function FakeAudioContext() {
      return {
        createMediaStreamSource: () => ({ connect: vi.fn(), disconnect }),
        createAnalyser: () => ({ fftSize: 0, getByteTimeDomainData: vi.fn() }),
        close,
      }
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    renderWithProviders(<MicrophoneSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByRole('button', { name: 'Stop test' })

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'studio-mic' } }),
    })
    expect(screen.getByRole('progressbar', { name: 'Microphone input level' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(stop).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('releases a microphone that opens after the settings tab unmounts', async () => {
    let resolveStream!: (stream: MediaStream) => void
    getUserMedia.mockReturnValue(new Promise<MediaStream>((resolve) => { resolveStream = resolve }))
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const audioContext = vi.fn()
    vi.stubGlobal('AudioContext', audioContext)
    const view = renderWithProviders(<MicrophoneSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(getUserMedia).toHaveBeenCalled()
    view.unmount()
    resolveStream(stream)

    await waitFor(() => expect(stop).toHaveBeenCalled())
    expect(audioContext).not.toHaveBeenCalled()
  })

  it('releases the microphone while AudioContext resume is pending', async () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    getUserMedia.mockResolvedValue(stream)
    let resolveResume!: () => void
    const resume = vi.fn(() => new Promise<void>((resolve) => { resolveResume = resolve }))
    const close = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', function FakeAudioContext() {
      return { state: 'suspended', resume, close }
    })
    const view = renderWithProviders(<MicrophoneSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await waitFor(() => expect(resume).toHaveBeenCalled())
    view.unmount()

    expect(stop).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
    resolveResume()
  })

  it('explains when microphone access is unavailable', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    renderWithProviders(<MicrophoneSettings />)

    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeDisabled()
    expect(screen.getByText(/not supported in this browser/i)).toBeInTheDocument()
  })
})
