// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useComposerOptions, type UseComposerOptionsArgs } from './composer-options'

// Mutable settings the mocked useSettings reads at call time, so tests can
// simulate the query resolving (undefined → loaded) and later refetches.
const state = vi.hoisted(() => ({ settings: undefined as unknown }))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: state.settings }),
}))

const LOADED_SETTINGS = {
  llmProvider: 'anthropic',
  models: { agentModel: 'opus' },
  llmProviderStatus: [
    { id: 'anthropic', catalog: [], defaultModels: { agent: 'sonnet' } },
  ],
}

function render(initialProps: UseComposerOptionsArgs) {
  return renderHook((props: UseComposerOptionsArgs) => useComposerOptions(props), {
    initialProps,
  })
}

describe('useComposerOptions default adoption', () => {
  beforeEach(() => {
    state.settings = LOADED_SETTINGS
  })

  it('adopts the agent default over the global default as sources stream in', () => {
    state.settings = undefined
    const { result, rerender } = render({ agentKey: 'a', agentDefaultsReady: false })
    expect(result.current.model).toBeUndefined()

    // Settings resolve first: adopt the global default.
    state.settings = LOADED_SETTINGS
    rerender({ agentKey: 'a', agentDefaultsReady: false })
    expect(result.current.model).toBe('opus')
    expect(result.current.effort).toBe('medium')

    // Agent preferences resolve later: the agent default wins.
    rerender({
      agentKey: 'a',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'high',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')
    expect(result.current.effort).toBe('high')
  })

  it('locks once both sources answered: a background default change cannot swap an untouched selection', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'high',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')

    // Another window edits the default and the query refetches mid-compose.
    rerender({
      agentKey: 'a',
      agentDefaultModel: 'sonnet',
      agentDefaultEffort: 'low',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')
    expect(result.current.effort).toBe('high')
  })

  it('followDefaults keeps tracking after load, including a reset back to the global default', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      followDefaults: true,
      agentDefaultModel: 'haiku',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')

    rerender({ agentKey: 'a', followDefaults: true, agentDefaultModel: 'sonnet', agentDefaultsReady: true })
    expect(result.current.model).toBe('sonnet')

    // Reset-to-global on the agent-home card: defaults cleared → global default.
    rerender({ agentKey: 'a', followDefaults: true, agentDefaultsReady: true })
    expect(result.current.model).toBe('opus')
  })

  it('an agentKey change unlocks and re-adopts, dropping to medium effort when the new agent has no defaults', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'max',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')
    expect(result.current.effort).toBe('max')

    // Quick-dispatch switches to an agent with no defaults (and no global
    // agentEffort configured): both knobs must follow.
    rerender({ agentKey: 'b', agentDefaultsReady: true })
    expect(result.current.model).toBe('opus')
    expect(result.current.effort).toBe('medium')
  })

  it('an explicit user pick survives default changes and agent switches', () => {
    const { result, rerender } = render({ agentKey: 'a', agentDefaultsReady: true })
    act(() => {
      result.current.setModel('claude-opus-4-7')
      result.current.setEffort('low')
    })

    rerender({
      agentKey: 'b',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'max',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-7')
    expect(result.current.effort).toBe('low')
  })

  it('omits untouched knobs from runtime options so the server resolves the defaults', () => {
    const { result } = render({
      agentKey: 'a',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'high',
      agentDefaultsReady: true,
    })
    // Adopted for display, but nothing was explicitly chosen — the wire bag
    // stays empty so a still-loading or later-edited default can't be beaten
    // by its own stale echo.
    expect(result.current.model).toBe('haiku')
    expect(result.current.toRuntimeOptions()).toEqual({})
  })

  it('serializes explicitly picked and session-seeded values', () => {
    const { result } = render({ agentKey: 'a', agentDefaultsReady: true })
    act(() => {
      result.current.setModel('claude-opus-4-7')
    })
    // Model picked, effort untouched: only the pick goes on the wire.
    expect(result.current.toRuntimeOptions()).toEqual({ model: 'claude-opus-4-7' })

    const seeded = render({
      initialModel: 'claude-opus-4-6',
      initialEffort: 'xhigh',
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(seeded.result.current.toRuntimeOptions()).toEqual({
      model: 'claude-opus-4-6',
      effort: 'xhigh',
    })
  })

  it('session-seeded initial values win over defaults', () => {
    const { result } = render({
      initialModel: 'claude-opus-4-6',
      initialEffort: 'xhigh',
      agentKey: 'a',
      agentDefaultModel: 'haiku',
      agentDefaultEffort: 'low',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-6')
    expect(result.current.effort).toBe('xhigh')
  })
})

// The composer surfaces the picker's "no web tools on this model" warning off GET webProvider
// (always the active vendor, including the unset default).
describe('useComposerOptions web provider', () => {
  it('exposes the active webProvider from settings', () => {
    state.settings = { ...LOADED_SETTINGS, webProvider: 'platform', webProviderIsDefault: true }
    const { result } = render({ agentKey: 'a', agentDefaultsReady: true })
    expect(result.current.webProvider).toBe('platform')
  })
})
