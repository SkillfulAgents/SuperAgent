import { execSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { getDataDir } from '@shared/lib/config/data-dir'

const PLATFORM_DEVICE_DIR = '.platform-auth'
const CLIENT_INSTANCE_FILENAME = 'client-instance-id'

function getPlatformDeviceDir() {
  return path.join(getDataDir(), PLATFORM_DEVICE_DIR)
}

function getClientInstanceIdPath() {
  return path.join(getPlatformDeviceDir(), CLIENT_INSTANCE_FILENAME)
}

export function getPlatformDeviceName(): string {
  if (process.platform === 'darwin') {
    try {
      return execSync('scutil --get ComputerName', { encoding: 'utf8' }).trim()
    } catch {
      // fall through
    }
  }
  return os.hostname().trim() || 'SuperAgent Device'
}

export function getOrCreatePlatformClientInstanceId() {
  const filePath = getClientInstanceIdPath()

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8').trim()
    if (existing) {
      return existing
    }
  }

  fs.mkdirSync(getPlatformDeviceDir(), { recursive: true })
  const clientInstanceId = crypto.randomUUID()
  fs.writeFileSync(filePath, clientInstanceId, { mode: 0o600 })
  return clientInstanceId
}
