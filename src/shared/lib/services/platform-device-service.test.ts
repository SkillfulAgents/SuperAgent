import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestAppRecordStore } from '@shared/lib/app-records/testing/memory-record-store'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from './platform-device-service'

describe('platform-device-service', () => {
  beforeEach(() => {
    installTestAppRecordStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists a stable client instance id', async () => {
    const first = await getOrCreatePlatformClientInstanceId()
    const second = await getOrCreatePlatformClientInstanceId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('agrees on one id when first uses race', async () => {
    const ids = await Promise.all([getOrCreatePlatformClientInstanceId(), getOrCreatePlatformClientInstanceId()])

    expect(ids[1]).toBe(ids[0])
    expect(await getOrCreatePlatformClientInstanceId()).toBe(ids[0])
  })

  it('returns a non-empty device name', () => {
    const name = getPlatformDeviceName()
    expect(name).toBeTruthy()
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })
})
