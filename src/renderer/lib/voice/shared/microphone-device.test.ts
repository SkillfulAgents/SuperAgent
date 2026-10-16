import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPreferredMicrophoneDeviceId,
  listMicrophoneDevices,
  setPreferredMicrophoneDeviceId,
} from './microphone-device'

describe('microphone device preferences', () => {
  const values = new Map<string, string>()

  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    })
    setPreferredMicrophoneDeviceId(null)
  })

  afterEach(() => {
    setPreferredMicrophoneDeviceId(null)
    vi.unstubAllGlobals()
  })

  it('persists a device id and clears it for the system default', () => {
    setPreferredMicrophoneDeviceId('usb-mic')
    expect(getPreferredMicrophoneDeviceId()).toBe('usb-mic')

    setPreferredMicrophoneDeviceId(null)
    expect(getPreferredMicrophoneDeviceId()).toBeNull()
  })

  it('ignores an empty stored device id', () => {
    localStorage.setItem('voice.microphoneDeviceId', '')
    expect(getPreferredMicrophoneDeviceId()).toBeNull()
  })

  it('keeps the active choice in memory when browser storage is blocked', () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('blocked') })

    setPreferredMicrophoneDeviceId('usb-mic')

    expect(getPreferredMicrophoneDeviceId()).toBe('usb-mic')
  })
})

describe('listMicrophoneDevices', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns only audio inputs with stable fallback labels', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'default', label: 'System microphone' },
          { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
          { kind: 'audioinput', deviceId: 'usb-mic', label: '' },
        ]),
      },
    })

    await expect(listMicrophoneDevices()).resolves.toEqual([
      { deviceId: 'default', label: 'System microphone' },
      { deviceId: 'usb-mic', label: 'Microphone 2' },
    ])
  })

  it('returns an empty list when enumeration is unavailable', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} })
    await expect(listMicrophoneDevices()).resolves.toEqual([])
  })
})
