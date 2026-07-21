import { describe, it, expect, vi } from 'vitest'
import {
  createCapabilityGateHook,
  CAPABILITY_REVIEW_HOOK_TIMEOUT_S,
  REVIEW_CANCELLED_REASON,
  type CapabilityGateContext,
} from './capability-gate-hook'
import { inputManager, HUMAN_INPUT_TTL_MS } from './input-manager'
import type { Capability } from './capability-policies'

function makeContext(overrides: Partial<CapabilityGateContext> = {}): {
  ctx: CapabilityGateContext
  grants: Set<Capability>
  onSessionGrant: ReturnType<typeof vi.fn>
  onReviewCancelled: ReturnType<typeof vi.fn>
} {
  const grants = new Set<Capability>()
  const onSessionGrant = vi.fn((capability: Capability) => grants.add(capability))
  const onReviewCancelled = vi.fn()
  const ctx: CapabilityGateContext = {
    sessionId: 'session-1',
    getPolicies: () => ({ subagents: 'review', workflows: 'review' }),
    getSessionGrants: () => grants,
    onSessionGrant,
    onReviewCancelled,
    ...overrides,
  }
  return { ctx, grants, onSessionGrant, onReviewCancelled }
}

function invoke(ctx: CapabilityGateContext, toolName: string, toolUseId: string, signal?: AbortSignal) {
  const hook = createCapabilityGateHook(ctx)
  return hook({ tool_name: toolName } as never, toolUseId, {
    signal: signal ?? new AbortController().signal,
  })
}

describe('createCapabilityGateHook', () => {
  it('passes non-capability tools through without parking', async () => {
    const { ctx } = makeContext()
    const result = await invoke(ctx, 'Bash', 'gate-pass-1')
    expect(result).toEqual({})
    expect(inputManager.hasPending('gate-pass-1')).toBe(false)
  })

  it('denies immediately when the capability is blocked', async () => {
    const { ctx } = makeContext({ getPolicies: () => ({ subagents: 'review', workflows: 'block' }) })
    const result = await invoke(ctx, 'Workflow', 'gate-block-1')
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    expect(inputManager.hasPending('gate-block-1')).toBe(false)
  })

  it('parks on review and allows after a one-time approval', async () => {
    const { ctx, onSessionGrant } = makeContext()
    const promise = invoke(ctx, 'Workflow', 'gate-once-1')
    expect(inputManager.hasPending('gate-once-1')).toBe(true)

    inputManager.resolve('gate-once-1', { scope: 'once' })
    expect(await promise).toEqual({})
    expect(onSessionGrant).not.toHaveBeenCalled()
  })

  it('records a session grant when the approval is session-scoped', async () => {
    const { ctx, grants, onSessionGrant } = makeContext()
    const promise = invoke(ctx, 'Task', 'gate-session-1')
    inputManager.resolve('gate-session-1', { scope: 'session' })
    expect(await promise).toEqual({})
    expect(onSessionGrant).toHaveBeenCalledWith('subagents')

    // A later launch under the grant doesn't park again.
    const second = await invoke(ctx, 'Task', 'gate-session-2')
    expect(second).toEqual({})
    expect(grants.has('subagents')).toBe(true)
    expect(inputManager.hasPending('gate-session-2')).toBe(false)
  })

  it('denies with the decline message when the user rejects', async () => {
    const { ctx, onReviewCancelled } = makeContext()
    const promise = invoke(ctx, 'Workflow', 'gate-decline-1')
    inputManager.reject('gate-decline-1', 'User declined')

    const result = await promise
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    expect(onReviewCancelled).not.toHaveBeenCalled()
  })

  it('wipes the pending entry and reports cancellation when the CLI aborts the hook', async () => {
    // The CLI abandons a parked hook on its per-hook timeout AND on turn
    // aborts/interrupts — both must clean up, or the pending entry zombies
    // until the 24h TTL while the host renders an unanswerable card.
    const { ctx, onReviewCancelled } = makeContext()
    const controller = new AbortController()
    const promise = invoke(ctx, 'Workflow', 'gate-abort-1', controller.signal)
    expect(inputManager.hasPending('gate-abort-1')).toBe(true)

    controller.abort()

    const result = await promise
    expect(inputManager.hasPending('gate-abort-1')).toBe(false)
    expect(onReviewCancelled).toHaveBeenCalledWith('gate-abort-1', 'workflows')
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    expect(
      (result as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput
        .permissionDecisionReason
    ).toContain(REVIEW_CANCELLED_REASON)
  })

  it('does not report cancellation for an abort after the review already settled', async () => {
    const { ctx, onReviewCancelled } = makeContext()
    const controller = new AbortController()
    const promise = invoke(ctx, 'Workflow', 'gate-late-abort-1', controller.signal)
    inputManager.resolve('gate-late-abort-1', { scope: 'once' })
    expect(await promise).toEqual({})

    // Listener was removed on settle — a later abort must not touch anything.
    controller.abort()
    expect(onReviewCancelled).not.toHaveBeenCalled()
  })

  it('keeps the hook timeout above the human-input TTL so the container rejects first', () => {
    expect(CAPABILITY_REVIEW_HOOK_TIMEOUT_S * 1000).toBeGreaterThan(HUMAN_INPUT_TTL_MS)
  })
})
