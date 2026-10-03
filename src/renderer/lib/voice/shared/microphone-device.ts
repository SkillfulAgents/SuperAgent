const MICROPHONE_DEVICE_STORAGE_KEY = 'voice.microphoneDeviceId'
let volatilePreferredDeviceId: string | null | undefined

export interface MicrophoneDeviceOption {
  deviceId: string
  label: string
}

function browserStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

export function getPreferredMicrophoneDeviceId(): string | null {
  if (volatilePreferredDeviceId !== undefined) return volatilePreferredDeviceId
  try {
    return browserStorage()?.getItem(MICROPHONE_DEVICE_STORAGE_KEY) || null
  } catch {
    return null
  }
}

export function setPreferredMicrophoneDeviceId(deviceId: string | null): void {
  try {
    const storage = browserStorage()
    if (!storage) {
      volatilePreferredDeviceId = deviceId
      return
    }
    if (deviceId) storage.setItem(MICROPHONE_DEVICE_STORAGE_KEY, deviceId)
    else storage.removeItem(MICROPHONE_DEVICE_STORAGE_KEY)
    volatilePreferredDeviceId = undefined
  } catch {
    volatilePreferredDeviceId = deviceId
  }
}

export async function listMicrophoneDevices(): Promise<MicrophoneDeviceOption[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []

  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((device) => device.kind === 'audioinput' && device.deviceId)
  const seen = new Set<string>()

  return inputs.flatMap((device, index) => {
    if (seen.has(device.deviceId)) return []
    seen.add(device.deviceId)
    return [{
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }]
  })
}
