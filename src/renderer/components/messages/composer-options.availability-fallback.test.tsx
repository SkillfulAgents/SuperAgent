// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import { useComposerOptions, type UseComposerOptionsArgs } from './composer-options'

// SUP-1143: a saved default the connection can no longer run (a plan
// downgrade) falls back to the best available model in new chats, which is sent
// explicitly so the server's own default resolution can't put the unavailable
// one on the wire.

const state = vi.hoisted(() => ({
  connections: undefined as unknown,
  denied: ['claude-fable-'] as string[],
  run: vi.fn(),
  announce: vi.fn(),
}))

vi.mock('@renderer/hooks/use-llm-connections', () => ({ useLlmConnections: () => ({ data: state.connections }) }))
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({ data: { llmProvider: 'platform', models: {}, llmProviderStatus: [] } }),
}))
// Restriction data is scoped to the selected connection.
vi.mock('@renderer/hooks/use-model-lock', () => ({
  useModelLock: (connection: { id: string } | undefined) =>
    connection?.id === 'platform-conn' && state.denied.length
      ? {
          isLocked: (m: ModelDefinition) => state.denied.some((p) => m.id.startsWith(p)),
          reason: (m: ModelDefinition) => `${m.label} isn't included in your Pro 30 plan.`,
          action: { label: 'Upgrade', run: state.run },
        }
      : undefined,
}))
vi.mock('@renderer/lib/model-fallback-notice', () => ({ announceModelFallback: state.announce }))

const model = (id: string, extra: Partial<ModelDefinition> = {}): ModelDefinition =>
  ({ id, label: id, icon: 'anthropic', supportedEfforts: ['medium'], ...extra })
const PLATFORM = {
  id: 'platform-conn',
  provider: 'platform',
  defaultModel: 'claude-opus-5-5',
  catalog: [
    model('claude-opus-5-5', { family: 'opus', isLatest: true, isDefault: true }),
    model('claude-fable-5-1', { family: 'fable', isLatest: true }),
  ],
}
const ANTHROPIC = { ...PLATFORM, id: 'anthropic-conn', provider: 'anthropic' }

function render(initialProps: UseComposerOptionsArgs) {
  return renderHook((props: UseComposerOptionsArgs) => useComposerOptions(props), { initialProps })
}

beforeEach(() => {
  state.denied = ['claude-fable-']
  state.run.mockReset()
  state.announce.mockReset()
  state.connections = { connections: [PLATFORM, ANTHROPIC], defaultSelection: { llmProviderId: 'platform-conn', model: 'claude-fable-5-1' } }
})

describe('useComposerOptions availability fallback', () => {
  it('shows and sends the best allowed model when the global default is excluded, and says so in the provider\'s words', () => {
    const { result } = render({})
    expect(result.current.model).toBe('claude-opus-5-5')
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'platform-conn', model: 'claude-opus-5-5' })
    expect(result.current.modelLock).toBeDefined()
    expect(state.announce).toHaveBeenCalledWith(expect.objectContaining({
      locked: expect.objectContaining({ id: 'claude-fable-5-1' }),
      fallback: expect.objectContaining({ id: 'claude-opus-5-5' }),
      reason: "claude-fable-5-1 isn't included in your Pro 30 plan.",
      action: expect.objectContaining({ label: 'Upgrade' }),
    }))
    // The notice's action runs the provider's action for the locked default.
    state.announce.mock.calls[0][0].action.run()
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-fable-5-1' }))
  })

  it('falls back from an excluded agent default too', () => {
    state.connections = { connections: [PLATFORM], defaultSelection: { llmProviderId: 'platform-conn', model: 'claude-opus-5-5' } }
    const { result } = render({ agentDefaultLlmProviderId: 'platform-conn', agentDefaultModel: 'fable' })
    expect(result.current.model).toBe('claude-opus-5-5')
    expect(result.current.toRuntimeOptions()).toMatchObject({ model: 'claude-opus-5-5' })
  })

  it('returns to the saved default once the plan allows it (no rewrite of the default)', () => {
    const { result, rerender } = render({})
    expect(result.current.model).toBe('claude-opus-5-5')
    state.denied = []
    rerender({})
    expect(result.current.model).toBe('claude-fable-5-1')
    // Untouched again: the server resolves the default itself.
    expect(result.current.toRuntimeOptions()).toEqual({})
  })

  it('leaves a session\'s own model alone; the 403 card covers it', () => {
    const { result } = render({ initialLlmProviderId: 'platform-conn', initialModel: 'claude-fable-5-1' })
    expect(result.current.model).toBe('claude-fable-5-1')
    expect(state.announce).not.toHaveBeenCalled()
  })

  it('leaves an existing session without model metadata (trigger-created) on its own model', () => {
    const { result } = render({ sessionId: 's1' })
    expect(result.current.model).toBe('claude-fable-5-1')
    expect(result.current.toRuntimeOptions()).toEqual({})
  })

  it('keeps an explicit pick of an allowed model', () => {
    const { result } = render({})
    act(() => result.current.setModel('claude-opus-5-5'))
    expect(result.current.toRuntimeOptions()).toMatchObject({ model: 'claude-opus-5-5' })
  })

  it('does not restrict a non-platform connection', () => {
    state.connections = { connections: [ANTHROPIC], defaultSelection: { llmProviderId: 'anthropic-conn', model: 'claude-fable-5-1' } }
    const { result } = render({})
    expect(result.current.model).toBe('claude-fable-5-1')
    expect(result.current.modelLock).toBeUndefined()
    expect(result.current.toRuntimeOptions()).toEqual({})
  })
})
