import { describe, expect, it } from 'vitest'
import { resolveSidebarVersionState } from './sidebar-version-state'

describe('resolveSidebarVersionState', () => {
  it('same versions, no feed: one number, nothing behind', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.14',
        cloudVersion: '0.5.14',
      }),
    ).toEqual({
      showPair: false,
      desktopBehind: false,
      cloudBehind: false,
      desktopWayBehind: false,
      cloudWayBehind: false,
      desktopVersion: '0.5.14',
      cloudVersion: '0.5.14',
    })
  })

  it('same versions, patch feed newer: pair, both behind, neither way behind', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.13',
        cloudVersion: '0.5.13',
        feedVersion: '0.5.14',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: true,
      cloudBehind: true,
      desktopWayBehind: false,
      cloudWayBehind: false,
    })
  })

  it('same versions, major feed newer: pair, both way behind', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.14',
        cloudVersion: '0.5.14',
        feedVersion: '0.6.0',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: true,
      cloudBehind: true,
      desktopWayBehind: true,
      cloudWayBehind: true,
    })
  })

  it('cloud only patch behind: pair, blue on cloud', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.14',
        cloudVersion: '0.5.13',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: false,
      cloudBehind: true,
      desktopWayBehind: false,
      cloudWayBehind: false,
    })
  })

  it('desktop only patch behind: pair, blue on desktop', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.13',
        cloudVersion: '0.5.14',
        feedVersion: '0.5.14',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: true,
      cloudBehind: false,
      desktopWayBehind: false,
      cloudWayBehind: false,
    })
  })

  it('cloud way behind desktop when desktop is latest', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.6.0',
        cloudVersion: '0.5.14',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: false,
      cloudBehind: true,
      desktopWayBehind: false,
      cloudWayBehind: true,
    })
  })

  it('desktop way behind when the feed matches a newer cloud', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.14',
        cloudVersion: '0.6.0',
        feedVersion: '0.6.0',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: true,
      cloudBehind: false,
      desktopWayBehind: true,
      cloudWayBehind: false,
    })
  })

  it('mixed: desktop patch behind, cloud way behind', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.6.0',
        cloudVersion: '0.5.14',
        feedVersion: '0.6.1',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: true,
      cloudBehind: true,
      desktopWayBehind: false,
      cloudWayBehind: true,
    })
  })

  it('cloud ahead of desktop with no feed: pair, nobody behind', () => {
    expect(
      resolveSidebarVersionState({
        desktopVersion: '0.5.14',
        cloudVersion: '0.5.15',
      }),
    ).toMatchObject({
      showPair: true,
      desktopBehind: false,
      cloudBehind: false,
      desktopWayBehind: false,
      cloudWayBehind: false,
    })
  })

  it('rc is behind the matching release, not way behind', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.12',
      cloudVersion: '0.5.12-rc.3',
    })
    expect(state).toMatchObject({
      showPair: true,
      cloudBehind: true,
      cloudWayBehind: false,
    })
  })

  it('rc cloud is not behind a stable desktop that is the latest', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.12',
      cloudVersion: '0.5.13-rc.2',
    })
    expect(state.desktopBehind).toBe(false)
    expect(state.cloudBehind).toBe(false)
    expect(state.showPair).toBe(true)
  })

  it('missing cloud version: no pair, no cloud side', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.14',
    })
    expect(state.showPair).toBe(false)
    expect(state.cloudVersion).toBeNull()
    expect(state.desktopBehind).toBe(false)
    expect(state.cloudBehind).toBe(false)
  })

  it('empty cloud version is treated as missing', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.14',
      cloudVersion: '',
    })
    expect(state.showPair).toBe(false)
    expect(state.cloudVersion).toBeNull()
  })

  it('invalid cloud version is treated as missing', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.14',
      cloudVersion: 'not-a-version',
    })
    expect(state.showPair).toBe(false)
    expect(state.cloudVersion).toBeNull()
    expect(state.desktopBehind).toBe(false)
    expect(state.cloudBehind).toBe(false)
  })

  it('cloud version with build metadata is treated as missing', () => {
    const state = resolveSidebarVersionState({
      desktopVersion: '0.5.14',
      cloudVersion: '0.5.14+build.1',
    })
    expect(state.showPair).toBe(false)
    expect(state.cloudVersion).toBeNull()
  })
})
