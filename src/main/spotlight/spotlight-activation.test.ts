import { describe, expect, it, vi } from 'vitest'
import type { ApiTarget } from '@shared/lib/api-target'
import { createSpotlightActivation, PENDING_SWITCH_TTL_MS, spotlightIdentifier } from './spotlight-activation'
import { encodeSpotlightId } from './spotlight-items'

function setup(active: ApiTarget = 'local') {
  let target = active
  let now = 0
  const deps = {
    activeTarget: () => target,
    openAgent: vi.fn(),
    openDashboard: vi.fn(),
    showMainWindow: vi.fn(),
    requestTargetSwitch: vi.fn(),
    now: () => now,
  }
  return {
    deps,
    activation: createSpotlightActivation(deps),
    switchTo(next: ApiTarget) {
      target = next
    },
    advance(ms: number) {
      now += ms
    },
  }
}

const cloudSession = encodeSpotlightId({ kind: 'session', target: 'cloud', agentSlug: 'finance', sessionId: 's1' })

describe('spotlightIdentifier', () => {
  it('reads the item id from the activity', () => {
    expect(spotlightIdentifier({ kCSSearchableItemActivityIdentifier: 'v1/x', kCSSearchQueryString: '' })).toBe('v1/x')
  })

  it.each([null, 'v1/x', {}, { kCSSearchableItemActivityIdentifier: 3 }, { kCSSearchableItemActivityIdentifier: '' }])(
    'is null for %j',
    (userInfo) => {
      expect(spotlightIdentifier(userInfo)).toBeNull()
    },
  )
})

describe('createSpotlightActivation', () => {
  it('opens a result from the Superagent the app is driving', () => {
    const { deps, activation } = setup('local')
    activation.activate(encodeSpotlightId({ kind: 'agent', target: 'local', agentSlug: 'finance' }))
    activation.activate(encodeSpotlightId({ kind: 'session', target: 'local', agentSlug: 'finance', sessionId: 's1' }))
    activation.activate(encodeSpotlightId({ kind: 'dashboard', target: 'local', agentSlug: 'finance', dashboardSlug: 'revenue' }))

    expect(deps.openAgent.mock.calls).toEqual([['finance', null], ['finance', 's1']])
    expect(deps.openDashboard).toHaveBeenCalledWith('finance', 'revenue')
    expect(deps.requestTargetSwitch).not.toHaveBeenCalled()
  })

  it('switches first for a result from the other side, and opens it once the switch has landed', () => {
    const { deps, activation, switchTo } = setup('local')
    activation.activate(cloudSession)
    expect(deps.requestTargetSwitch).toHaveBeenCalledWith('cloud')
    expect(deps.openAgent).not.toHaveBeenCalled()

    // A mount on the old side (the window recreated to carry the request).
    activation.resumeAfterSwitch()
    expect(deps.openAgent).not.toHaveBeenCalled()

    switchTo('cloud')
    activation.resumeAfterSwitch()
    activation.resumeAfterSwitch()
    expect(deps.openAgent.mock.calls).toEqual([['finance', 's1']])
  })

  it('drops a result whose switch was declined, so a later switch of the user’s own does not open it', () => {
    const { deps, activation, switchTo } = setup('local')
    activation.activate(cloudSession)
    activation.switchDeclined()

    switchTo('cloud')
    activation.resumeAfterSwitch()
    expect(deps.openAgent).not.toHaveBeenCalled()
  })

  it('drops a result whose switch never landed', () => {
    const { deps, activation, switchTo, advance } = setup('local')
    activation.activate(cloudSession)
    advance(PENDING_SWITCH_TTL_MS + 1)
    switchTo('cloud')
    activation.resumeAfterSwitch()

    expect(deps.openAgent).not.toHaveBeenCalled()
  })

  it('lets a newer click replace one still waiting on a switch', () => {
    const { deps, activation } = setup('cloud')
    activation.activate(encodeSpotlightId({ kind: 'agent', target: 'local', agentSlug: 'research' }))
    activation.activate(encodeSpotlightId({ kind: 'agent', target: 'cloud', agentSlug: 'finance' }))
    activation.resumeAfterSwitch()

    expect(deps.openAgent.mock.calls).toEqual([['finance', null]])
  })

  it('treats a switch-to result as the switch itself', () => {
    const { deps, activation, switchTo } = setup('local')
    activation.activate(encodeSpotlightId({ kind: 'workspace', target: 'cloud' }))
    expect(deps.requestTargetSwitch).toHaveBeenCalledWith('cloud')

    switchTo('cloud')
    activation.resumeAfterSwitch()
    activation.activate(encodeSpotlightId({ kind: 'workspace', target: 'cloud' }))
    expect(deps.showMainWindow).toHaveBeenCalledTimes(1)
    expect(deps.requestTargetSwitch).toHaveBeenCalledTimes(1)
  })

  it('shows the window for an id it does not recognize', () => {
    const { deps, activation } = setup()
    activation.activate('local|superagent://agent/finance')

    expect(deps.showMainWindow).toHaveBeenCalled()
    expect(deps.openAgent).not.toHaveBeenCalled()
  })
})
