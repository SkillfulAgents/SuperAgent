// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import { useComposerOptions, type UseComposerOptionsArgs } from './composer-options'

// SUP-1124: a model the provider says cannot run (the plan excludes it) counts
// as unset, as on the server: the composer shows the next runnable model down
// the chat's model → agent default → global default → the connection's own
// default, and an untouched new chat sends nothing so the server walks the same list.

const state = vi.hoisted(() => ({
  connections: undefined as unknown,
  denied: ['claude-fable-'] as string[],
  announce: vi.fn(),
}))

vi.mock('@renderer/hooks/use-llm-connections', () => ({ useLlmConnections: () => ({ data: state.connections }) }))
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({ data: { llmProvider: 'platform', models: {}, llmProviderStatus: [] } }),
}))
// Restrictions come from the platform connection's provider only.
const reasonFor = (llmProviderId: string | undefined, modelId: string | undefined) =>
  llmProviderId === 'platform-conn' && modelId && state.denied.some((p) => modelId.startsWith(p))
    ? `${modelId} isn't included in your Pro 30 plan.`
    : undefined
vi.mock('@renderer/hooks/use-provider-model-availability', () => ({
  useModelAvailabilities: () => ({
    reasonFor,
    availabilityOf: (llmProviderId: string | undefined) =>
      llmProviderId === 'platform-conn' && state.denied.length
        ? { unavailable: [], summary: null, action: { component: 'plan-upgrade', label: 'Upgrade', href: null } }
        : null,
  }),
}))
vi.mock('@renderer/hooks/use-model-lock', () => ({
  useModelLock: (connection: { id: string } | undefined) =>
    connection?.id === 'platform-conn' && state.denied.length
      ? { isLocked: (m: ModelDefinition) => !!reasonFor(connection.id, m.id), reason: (m: ModelDefinition) => reasonFor(connection.id, m.id) ?? '' }
      : undefined,
}))
vi.mock('@renderer/lib/model-fallback-notice', () => ({ announceModelFallback: state.announce }))

const model = (id: string, extra: Partial<ModelDefinition> = {}): ModelDefinition =>
  ({ id, label: id, icon: 'anthropic', supportedEfforts: ['medium'], ...extra })
const CATALOG = [
  model('claude-opus-5-5', { family: 'opus', isLatest: true, isDefault: true }),
  model('claude-fable-5-1', { family: 'fable', isLatest: true }),
]
const PLATFORM = { id: 'platform-conn', provider: 'platform', defaultModel: 'claude-opus-5-5', catalog: CATALOG }
const ANTHROPIC = { ...PLATFORM, id: 'anthropic-conn', provider: 'anthropic' }

function render(initialProps: UseComposerOptionsArgs) {
  return renderHook((props: UseComposerOptionsArgs) => useComposerOptions(props), { initialProps })
}

beforeEach(() => {
  state.denied = ['claude-fable-']
  state.announce.mockReset()
  state.connections = { connections: [PLATFORM, ANTHROPIC], defaultSelection: { llmProviderId: 'platform-conn', model: 'claude-fable-5-1' } }
})

describe('useComposerOptions: a locked model counts as unset', () => {
  it('shows the connection\'s default when the global default is locked, sends nothing, and says why once', () => {
    const { result } = render({})
    expect(result.current.model).toBe('claude-opus-5-5')
    expect(result.current.llmProviderId).toBe('platform-conn')
    // An untouched new chat: the server walks the same list.
    expect(result.current.toRuntimeOptions()).toEqual({})
    expect(state.announce).toHaveBeenCalledWith(expect.objectContaining({
      locked: expect.objectContaining({ id: 'claude-fable-5-1' }),
      fallback: expect.objectContaining({ id: 'claude-opus-5-5' }),
      reason: "claude-fable-5-1 isn't included in your Pro 30 plan.",
      action: expect.objectContaining({ label: 'Upgrade' }),
    }))
  })

  it('goes from a locked agent default to the global default', () => {
    state.connections = { connections: [PLATFORM], defaultSelection: { llmProviderId: 'platform-conn', model: 'claude-opus-5-5' } }
    const { result } = render({ agentDefaultLlmProviderId: 'platform-conn', agentDefaultModel: 'fable' })
    expect(result.current.model).toBe('claude-opus-5-5')
    expect(result.current.toRuntimeOptions()).toEqual({})
  })

  it('follows the list onto another connection when that is where the next runnable default is', () => {
    state.connections = { connections: [PLATFORM, ANTHROPIC], defaultSelection: { llmProviderId: 'anthropic-conn', model: 'claude-fable-5-1' } }
    const { result } = render({ agentDefaultLlmProviderId: 'platform-conn', agentDefaultModel: 'claude-fable-5-1' })
    expect(result.current.llmProviderId).toBe('anthropic-conn')
    expect(result.current.model).toBe('claude-fable-5-1')
  })

  it('returns to the saved default once it can run (the default is never rewritten)', () => {
    const { result, rerender } = render({})
    expect(result.current.model).toBe('claude-opus-5-5')
    state.denied = []
    rerender({})
    expect(result.current.model).toBe('claude-fable-5-1')
    expect(result.current.toRuntimeOptions()).toEqual({})
  })

  it('moves a chat whose own model got locked to the next runnable one, and sends it', () => {
    const { result } = render({ sessionId: 's1', initialLlmProviderId: 'platform-conn', initialModel: 'claude-fable-5-1' })
    expect(result.current.model).toBe('claude-opus-5-5')
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'platform-conn', model: 'claude-opus-5-5' })
  })

  it('keeps an explicit pick of a runnable model', () => {
    const { result } = render({})
    act(() => result.current.setModel('claude-opus-5-5'))
    expect(result.current.toRuntimeOptions()).toMatchObject({ model: 'claude-opus-5-5' })
  })

  it('restricts nothing on a connection whose provider does not', () => {
    state.connections = { connections: [ANTHROPIC], defaultSelection: { llmProviderId: 'anthropic-conn', model: 'claude-fable-5-1' } }
    const { result } = render({})
    expect(result.current.model).toBe('claude-fable-5-1')
    expect(result.current.modelLock).toBeUndefined()
    expect(result.current.toRuntimeOptions()).toEqual({})
    expect(state.announce).not.toHaveBeenCalled()
  })
})
