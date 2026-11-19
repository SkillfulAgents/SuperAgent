// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, render as renderUi, screen } from '@testing-library/react'
import { DraftsProvider, useDraftsStore, type DraftsStore } from '@renderer/context/drafts-context'
import { useComposerOptions, type ComposerOptionsController, type ComposerOptionsState, type UseComposerOptionsArgs } from './composer-options'
import { ComposerOptionsPopover } from './composer-options-popover'

// No provider locks a model here (model locks have their own tests).
vi.mock('@renderer/hooks/use-model-lock', () => ({ useModelLock: () => undefined }))
vi.mock('@renderer/hooks/use-provider-model-availability', () => ({
  useModelAvailabilities: () => ({ reasonFor: () => undefined, availabilityOf: () => null }),
}))

// Mutable settings the mocked useModelSettings reads at call time, so tests can
// simulate the query resolving (undefined → loaded) and later refetches.
const state = vi.hoisted(() => ({ settings: undefined as unknown, connections: undefined as unknown }))

vi.mock('@renderer/hooks/use-llm-connections', () => ({ useLlmConnections: () => ({ data: state.connections }) }))

vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({ data: state.settings }),
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

beforeEach(() => { state.connections = undefined })

describe('useComposerOptions default adoption', () => {
  beforeEach(() => {
    state.settings = LOADED_SETTINGS
  })

  it('keeps model picks before a connection has been configured', () => {
    state.connections = { connections: [], defaultSelection: null }
    const { result } = render({})
    act(() => result.current.setModel('claude-haiku-4-5'))
    expect(result.current.model).toBe('claude-haiku-4-5')
    expect(result.current.toRuntimeOptions()).toEqual({ model: 'claude-haiku-4-5' })
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
      agentDefault: { model: 'haiku', effort: 'high' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')
    expect(result.current.effort).toBe('high')
  })

  it('locks once both sources answered: a background default change cannot swap an untouched selection', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      agentDefault: { model: 'haiku', effort: 'high' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')

    // Another window edits the default and the query refetches mid-compose.
    rerender({
      agentKey: 'a',
      agentDefault: { model: 'sonnet', effort: 'low' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')
    expect(result.current.effort).toBe('high')
  })

  it('followDefaults keeps tracking after load, including a reset back to the global default', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      followDefaults: true,
      agentDefault: { model: 'haiku' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('haiku')

    rerender({ agentKey: 'a', followDefaults: true, agentDefault: { model: 'sonnet' }, agentDefaultsReady: true })
    expect(result.current.model).toBe('sonnet')

    // Reset-to-global on the agent-home card: defaults cleared → global default.
    rerender({ agentKey: 'a', followDefaults: true, agentDefaultsReady: true })
    expect(result.current.model).toBe('opus')
  })

  it('an agentKey change unlocks and re-adopts, dropping to medium effort when the new agent has no defaults', () => {
    const { result, rerender } = render({
      agentKey: 'a',
      agentDefault: { model: 'haiku', effort: 'max' },
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
      agentDefault: { model: 'haiku', effort: 'max' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-7')
    expect(result.current.effort).toBe('low')
  })

  it('omits untouched knobs from runtime options so the server resolves the defaults', () => {
    const { result } = render({
      agentKey: 'a',
      agentDefault: { model: 'haiku', effort: 'high' },
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
      initial: { model: 'claude-opus-4-6', effort: 'xhigh' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(seeded.result.current.toRuntimeOptions()).toEqual({
      model: 'claude-opus-4-6',
      effort: 'xhigh',
    })
  })

  it('serializes an explicitly picked speed so the dispatch payload carries it', () => {
    const { result } = render({ agentKey: 'a', agentDefaultsReady: true })
    expect(result.current.toRuntimeOptions()).toEqual({})
    act(() => {
      result.current.setSpeed('fast')
    })
    expect(result.current.toRuntimeOptions()).toEqual({ speed: 'fast' })
  })

  it('session-seeded initial values win over defaults', () => {
    const { result } = render({
      initial: { model: 'claude-opus-4-6', effort: 'xhigh' },
      agentKey: 'a',
      agentDefault: { model: 'haiku', effort: 'low' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-6')
    expect(result.current.effort).toBe('xhigh')
  })

  it('adopts a newer authoritative session model after mounting from stale cached detail', () => {
    const { result, rerender } = render({
      initial: { model: 'claude-opus-4-6' },
      agentKey: 'a',
      agentDefault: { model: 'haiku' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-6')

    // React Query can render cached session detail first, then deliver the
    // refetched last-used model. The refreshed session value must replace the
    // stale seed and be the value sent on the next turn.
    rerender({
      initial: { model: 'claude-sonnet-4-6' },
      agentKey: 'a',
      agentDefault: { model: 'haiku' },
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-sonnet-4-6')
    expect(result.current.toRuntimeOptions()).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('protects an unsent model pick, then follows session updates after submit succeeds', () => {
    const { result, rerender } = render({
      initial: { model: 'claude-opus-4-6' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    act(() => result.current.setModel('claude-sonnet-4-6'))

    // A peer update/refetch must not erase a local choice that has not reached
    // the server yet.
    rerender({
      initial: { model: 'claude-haiku-4-5' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-sonnet-4-6')

    act(() => result.current.markSubmitted({ model: 'claude-sonnet-4-6' }))
    rerender({
      initial: { model: 'claude-sonnet-4-6' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })

    // Once acknowledged, a later peer's accepted model is authoritative.
    rerender({
      initial: { model: 'claude-opus-4-8' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(result.current.model).toBe('claude-opus-4-8')
    expect(result.current.toRuntimeOptions()).toEqual({ model: 'claude-opus-4-8' })
  })

  it('applies the same authoritative refresh and unsent-edit protection to effort and speed', () => {
    const { result, rerender } = render({
      initial: { effort: 'medium', speed: 'normal' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })

    rerender({
      initial: { effort: 'high', speed: 'fast' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(result.current.effort).toBe('high')
    expect(result.current.speed).toBe('fast')

    act(() => {
      result.current.setEffort('low')
      result.current.setSpeed('slow')
    })
    rerender({
      initial: { effort: 'xhigh', speed: 'normal' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(result.current.effort).toBe('low')
    expect(result.current.speed).toBe('slow')

    act(() => result.current.markSubmitted({ effort: 'low', speed: 'slow' }))
    rerender({
      initial: { effort: 'low', speed: 'slow' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    rerender({
      initial: { effort: 'high', speed: 'fast' },
      agentKey: 'a',
      agentDefaultsReady: true,
    })
    expect(result.current.effort).toBe('high')
    expect(result.current.speed).toBe('fast')
  })
})

describe('useComposerOptions web provider', () => {
  it('exposes the active webProvider from settings', () => {
    state.settings = { ...LOADED_SETTINGS, webProvider: 'platform', webProviderIsDefault: true }
    const { result } = render({ agentKey: 'a', agentDefaultsReady: true })
    expect(result.current.webProvider).toBe('platform')
  })
})


describe('connection/model selection', () => {
  const model = (id: string) => ({ id, label: id, supportedEfforts: ['low', 'medium', 'high'] })
  const first = { id: 'global', defaultModel: 'same', catalog: [model('same'), model('global-default')] }
  const second = { id: 'personal', defaultModel: 'same', catalog: [model('same'), model('personal-other')] }
  beforeEach(() => {
    state.settings = LOADED_SETTINGS
    state.connections = { connections: [first, second], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
  })
  it('retains a model picked while the connection query is still pending', () => {
    state.connections = undefined
    const { result, rerender } = render({})
    act(() => result.current.setModel('same'))
    state.connections = { connections: [first, second], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
    rerender({})
    expect(result.current.model).toBe('same')
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'global', model: 'same' })
  })

  it('binds a model pick to the inherited connection before the initial query has settled', () => {
    state.connections = undefined
    const { result, rerender } = render({ initial: { model: 'same' } })
    state.connections = { connections: [first, second], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
    rerender({ initial: { model: 'same' } })
    act(() => result.current.setModel('same'))
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'global', model: 'same' })
  })

  it('uses the server-resolved provider default instead of the first family default', () => {
    const platform = { id: 'platform', defaultModel: 'grok', catalog: [
      { ...model('opus-id'), family: 'opus', isDefault: true, isLatest: true },
      { ...model('grok-id'), family: 'grok', isDefault: true, isLatest: true },
    ] }
    state.connections = { connections: [first, platform], defaultSelection: { llmProviderId: 'global', model: 'same' } }
    const { result } = render({ initial: { llmProviderId: 'global', model: 'same' } })
    act(() => result.current.setConnection?.('platform'))
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'platform', model: 'grok' })
  })

  it('changes accounts even when both expose the same model ID', () => {
    const { result } = render({ initial: { llmProviderId: 'global', model: 'same' } })
    act(() => result.current.setConnection?.('personal'))
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'personal', model: 'same' })
    expect(result.current.catalog).toEqual(second.catalog)
  })
  it('drops the whole deleted pair instead of charging another account for the orphaned model', () => {
    const { result, rerender } = render({ initial: { llmProviderId: 'personal', model: 'same' } })
    state.connections = { connections: [first], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
    rerender({ initial: { llmProviderId: 'personal', model: 'same' } })
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'global', model: 'global-default' })
  })
  it('drops a removed model before considering an agent default', () => {
    const { result } = render({ initial: { llmProviderId: 'personal', model: 'removed' }, agentDefault: { llmProviderId: 'personal', model: 'personal-other' } })
    expect(result.current.llmProviderId).toBe('personal')
    expect(result.current.model).toBe('personal-other')
  })
  it('protects an unsent account change from an authoritative refetch', () => {
    const { result, rerender } = render({ initial: { llmProviderId: 'global', model: 'same' } })
    act(() => result.current.setConnection?.('personal'))
    rerender({ initial: { llmProviderId: 'global', model: 'global-default' } })
    expect(result.current.toRuntimeOptions()).toMatchObject({ llmProviderId: 'personal', model: 'same' })
  })
})

describe('effort the selected model cannot run', () => {
  // No Medium: the popover's clamp would snap the built-in medium start to Low.
  const flash = { id: 'deepseek-flash', label: 'DeepSeek Flash', family: 'deepseek', isLatest: true, icon: 'deepseek', supportedEfforts: ['low', 'high', 'max'] }
  const settingsWith = (agentEffort?: string) => ({
    llmProvider: 'anthropic',
    models: { agentModel: 'deepseek-flash', ...(agentEffort ? { agentEffort } : {}) },
    llmProviderStatus: [{ id: 'anthropic', catalog: [flash], defaultModels: { agent: 'deepseek-flash' } }],
  })

  // The real popover as a child, so its clamp effect runs before the hook's
  // adoption effect, as in the app.
  function Composer({ onState }: { onState: (s: ComposerOptionsState) => void }) {
    const composer = useComposerOptions({ agentKey: 'a', followDefaults: true, agentDefaultsReady: true })
    onState(composer)
    return <ComposerOptionsPopover state={composer} />
  }

  it('adopts the default effort instead of locking in the clamped Low', () => {
    state.settings = settingsWith('max')
    let composer: ComposerOptionsState | undefined
    renderUi(<Composer onState={(s) => { composer = s }} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('DeepSeek Flash · Max')
    expect(composer?.toRuntimeOptions()).not.toHaveProperty('effort')
  })

  it('shows an unsupported default clamped but leaves it off the wire', () => {
    state.settings = settingsWith()
    let composer: ComposerOptionsState | undefined
    renderUi(<Composer onState={(s) => { composer = s }} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('DeepSeek Flash · Low')
    expect(composer?.toRuntimeOptions()).not.toHaveProperty('effort')
  })
})

/** The hook under one long-lived provider, so a test can unmount just the composer and mount it again. */
function renderDrafted(initialProps: UseComposerOptionsArgs) {
  const latest: { options?: ComposerOptionsController; store?: DraftsStore } = {}
  function Probe({ props }: { props: UseComposerOptionsArgs }) {
    latest.options = useComposerOptions(props)
    latest.store = useDraftsStore()
    return null
  }
  let mount = 0
  const tree = (props: UseComposerOptionsArgs) => <DraftsProvider><Probe key={mount} props={props} /></DraftsProvider>
  const view = renderUi(tree(initialProps))
  return {
    latest: latest as Required<typeof latest>,
    rerender: (props: UseComposerOptionsArgs) => view.rerender(tree(props)),
    remount: (props: UseComposerOptionsArgs = initialProps) => {
      mount += 1
      view.rerender(tree(props))
    },
  }
}

describe('picks kept with the composer draft', () => {
  const KEY = 'session:s-1'
  const sessionArgs: UseComposerOptionsArgs = { initial: { model: 'opus', effort: 'medium' }, agentKey: 'a', agentDefaultsReady: true, draftKey: KEY }
  const model = (id: string) => ({ id, label: id, supportedEfforts: ['low', 'medium', 'high'] })
  const global = { id: 'global', defaultModel: 'same', catalog: [model('same'), model('global-default')] }
  const personal = { id: 'personal', defaultModel: 'same', catalog: [model('same')] }
  const bothConnections = { connections: [global, personal], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
  const accountArgs: UseComposerOptionsArgs = { initial: { llmProviderId: 'global', model: 'same' }, draftKey: KEY }
  beforeEach(() => { state.settings = LOADED_SETTINGS })

  it('brings unsent picks back when the composer mounts again, and still sends them', () => {
    const { latest, remount } = renderDrafted(sessionArgs)
    act(() => {
      latest.options.setModel('haiku')
      latest.options.setEffort('high')
      latest.options.setSpeed('fast')
    })
    expect(latest.store.get(KEY)).toEqual({ options: { model: 'haiku', effort: 'high', speed: 'fast' } })

    remount()

    expect(latest.options.model).toBe('haiku')
    expect(latest.options.effort).toBe('high')
    expect(latest.options.speed).toBe('fast')
    expect(latest.options.toRuntimeOptions()).toEqual({ model: 'haiku', effort: 'high', speed: 'fast' })
  })

  it('keeps a pick that came back ahead of a later session refetch, like one made in place', () => {
    const { latest, remount, rerender } = renderDrafted(sessionArgs)
    act(() => latest.options.setModel('haiku'))
    remount()
    rerender({ ...sessionArgs, initial: { model: 'sonnet', effort: 'medium' } })
    expect(latest.options.model).toBe('haiku')
  })

  it('never keeps what the session runs on or a default it adopted, only a pick', () => {
    const { latest, rerender } = renderDrafted({ ...sessionArgs, agentDefault: { model: 'sonnet', speed: 'fast' } })
    rerender({ ...sessionArgs, initial: { model: 'haiku', effort: 'high' }, agentDefault: { model: 'sonnet', speed: 'fast' } })
    expect(latest.store.get(KEY)).toBeUndefined()

    // A new chat with nothing picked sends nothing, so the server resolves the defaults; the draft holds nothing either.
    const fresh = renderDrafted({ agentKey: 'a', agentDefault: { model: 'haiku', effort: 'high' }, agentDefaultsReady: true, draftKey: 'new-session:a' })
    expect(fresh.latest.options.model).toBe('haiku')
    expect(fresh.latest.options.toRuntimeOptions()).toEqual({})
    expect(fresh.latest.store.get('new-session:a')).toBeUndefined()
  })

  it('keeps nothing without a draft key, and needs no drafts provider then', () => {
    const { result } = render({ initial: { model: 'opus' } })
    act(() => result.current.setModel('haiku'))
    act(() => result.current.markSubmitted({ model: 'haiku' }))
    expect(result.current.model).toBe('haiku')
  })

  it('lets go of a pick once the server has accepted it, knob by knob', () => {
    const { latest, remount } = renderDrafted(sessionArgs)
    act(() => {
      latest.options.setModel('haiku')
      latest.options.setSpeed('fast')
    })
    // A queued message carries no options, so nothing was accepted.
    act(() => latest.options.markSubmitted({}))
    expect(latest.store.get(KEY)).toEqual({ options: { model: 'haiku', speed: 'fast' } })

    act(() => latest.options.markSubmitted({ model: 'haiku' }))
    expect(latest.store.get(KEY)).toEqual({ options: { speed: 'fast' } })
    act(() => latest.options.markSubmitted(latest.options.toRuntimeOptions()))
    expect(latest.store.get(KEY)).toBeUndefined()

    // From here the session's own model is the authority again.
    remount({ ...sessionArgs, initial: { model: 'sonnet', effort: 'medium' } })
    expect(latest.options.model).toBe('sonnet')
  })

  it('brings a connection pick back with its model, and falls back when that connection has gone meanwhile', () => {
    state.connections = bothConnections
    const { latest, remount } = renderDrafted(accountArgs)
    act(() => latest.options.setConnection?.('personal'))
    expect(latest.store.get(KEY)).toEqual({ options: { llmProviderId: 'personal', model: 'same' } })

    remount()
    expect(latest.options.toRuntimeOptions()).toMatchObject({ llmProviderId: 'personal', model: 'same' })

    state.connections = { connections: [global], defaultSelection: { llmProviderId: 'global', model: 'global-default' } }
    remount()
    const sent = latest.options.toRuntimeOptions()
    // The pair is checked as one: the gone connection's model is not charged to another that happens to have it.
    expect(sent).toMatchObject({ llmProviderId: 'global', model: 'same' })

    // What the pick resolved to was sent, so the pick that could not run is not left behind.
    act(() => latest.options.markSubmitted(sent))
    expect(latest.store.get(KEY)).toBeUndefined()
  })

  it('sends a connection that came back with its model while the connections are still loading', () => {
    state.connections = bothConnections
    const { latest, remount } = renderDrafted(accountArgs)
    act(() => latest.options.setConnection?.('personal'))

    // Back in the session before the connections query has answered.
    state.connections = undefined
    remount()

    // Not the model alone, which the server would run on the session's connection.
    const sent = latest.options.toRuntimeOptions()
    expect(sent).toMatchObject({ llmProviderId: 'personal', model: 'same' })
    act(() => latest.options.markSubmitted(sent))
    expect(latest.store.get(KEY)).toBeUndefined()
  })

  it('does not let an earlier send, finishing late, take a pick made since', () => {
    const { latest, remount } = renderDrafted(sessionArgs)
    act(() => {
      latest.options.setModel('haiku')
      latest.options.setEffort('high')
      latest.options.setSpeed('fast')
    })
    const sentFrom = latest.options
    const sent = sentFrom.toRuntimeOptions()

    // Leave and come back while that send is in flight, then pick again.
    remount()
    act(() => {
      latest.options.setModel('sonnet')
      latest.options.setEffort('low')
      latest.options.setSpeed('normal')
    })
    act(() => sentFrom.markSubmitted(sent))

    expect(latest.store.get(KEY)?.options).toEqual({ model: 'sonnet', effort: 'low', speed: 'normal' })
  })

  it('does not let an earlier send take a connection picked since', () => {
    state.connections = bothConnections
    const { latest, remount } = renderDrafted(accountArgs)
    act(() => latest.options.setConnection?.('personal'))
    const sentFrom = latest.options
    const sent = sentFrom.toRuntimeOptions()

    remount()
    act(() => latest.options.setModel('global-default'))
    act(() => latest.options.setConnection?.('global'))
    act(() => sentFrom.markSubmitted(sent))

    expect(latest.store.get(KEY)?.options).toMatchObject({ llmProviderId: 'global' })
  })
})
