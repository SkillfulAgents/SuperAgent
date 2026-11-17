import { describe, expect, it } from 'vitest'
import { closeAppState, createLocalAppState, initializeAppState, LocalAppStateBackend } from '@shared/lib/app-state'
import { claimPlatformNotificationBroadcast, PLATFORM_NOTIFICATION_SEEN_TTL_MS } from './platform-notification-seen'

describe('claimPlatformNotificationBroadcast', () => {
  it('lets exactly one of several processes claim the same row', async () => {
    // Clients of one backend are processes of one tenant, each holding a realtime connection.
    const backend = new LocalAppStateBackend()
    const processes = Array.from({ length: 5 }, () => createLocalAppState({ backend }))

    const claims = await Promise.all(processes.map((state) => claimPlatformNotificationBroadcast('member-1', 'ntf_1', state)))

    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('refuses a replay of a claimed row, and claims each row and member on its own', async () => {
    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_1')).toBe(true)
    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_1')).toBe(false)
    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_2')).toBe(true)
    expect(await claimPlatformNotificationBroadcast('member-2', 'ntf_1')).toBe(true)
  })

  it('keeps a claim for a day, then lets it go', async () => {
    let clock = Date.parse('2026-07-01T00:00:00Z')
    await closeAppState()
    await initializeAppState(createLocalAppState({ backend: new LocalAppStateBackend({ now: () => clock }) }))

    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_1')).toBe(true)
    clock += PLATFORM_NOTIFICATION_SEEN_TTL_MS - 1
    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_1')).toBe(false)
    clock += 1
    expect(await claimPlatformNotificationBroadcast('member-1', 'ntf_1')).toBe(true)
    expect(PLATFORM_NOTIFICATION_SEEN_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
