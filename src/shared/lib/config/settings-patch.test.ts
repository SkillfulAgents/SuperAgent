import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from './settings'
import {
  applySettingsPatch,
  settingsPatchSchema,
  validateSettingsTransition,
  type SettingsApplyContext,
  type SettingsPatch,
  type SettingsTransitionContext,
} from './settings-patch'

function currentSettings(): AppSettings {
  return {
    container: {
      containerRunner: 'docker',
      agentImage: 'superagent:latest',
      resourceLimits: { cpu: 2, memory: '4g' },
      runtimeSettings: {
        docker: { network: 'bridge' },
        lima: { vmMemory: '4GiB', cpu: '4' },
      },
    },
    app: {
      showMenuBarIcon: true,
      hostBrowserProvider: 'chrome',
    },
    apiKeys: {
      anthropicApiKey: 'sk-old',
      openrouterApiKey: 'or-old',
    },
    llmProvider: 'anthropic',
    webProvider: 'exa',
    models: {
      summarizerModel: 'haiku',
      agentModel: 'opus',
      browserModel: 'sonnet',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    },
    auth: { signupMode: 'open' },
    agentCapabilities: { subagents: 'allow', workflows: 'review' },
    skillsets: [],
    platformAuth: {
      token: 'secret',
      tokenPreview: 'sec…ret',
      email: 'test@example.com',
      label: null,
      orgId: null,
      orgName: null,
      role: null,
      userId: null,
      memberId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

const applyContext: SettingsApplyContext = {
  now: new Date('2026-08-03T12:34:56.000Z'),
  getProviderDefaultModels: vi.fn(() => ({
    summarizerModel: 'new-haiku',
    agentModel: 'new-opus',
    browserModel: 'new-sonnet',
    dashboardBuilderModel: 'new-opus',
  })),
}

const transitionContext: SettingsTransitionContext = {
  hasRunningAgents: false,
  hostTotalMemoryBytes: 64 * 1024 ** 3,
  supportsCustomAgentImage: (runner) => runner !== 'lambda-microvm',
}

function parsePatch(input: unknown): SettingsPatch {
  return settingsPatchSchema.parse(input)
}

describe('settingsPatchSchema', () => {
  it('rejects unknown root, nested, and server-owned fields', () => {
    expect(settingsPatchSchema.safeParse({ futureRoot: true }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ app: { futureAppField: true } }).success).toBe(false)
    expect(
      settingsPatchSchema.safeParse({ app: { faviconUpdatedAt: 'user-controlled' } }).success,
    ).toBe(false)
  })

  it('accepts null and empty-string clear semantics', () => {
    expect(
      settingsPatchSchema.safeParse({
        webProvider: null,
        app: { hostBrowserProvider: null, faviconDataUrl: '' },
        apiKeys: { anthropicApiKey: '' },
      }).success,
    ).toBe(true)
  })
})

describe('applySettingsPatch', () => {
  it('deep-merges container limits while preserving unrelated runtime settings', () => {
    const before = currentSettings()
    const after = applySettingsPatch(
      before,
      parsePatch({ container: { resourceLimits: { cpu: 6 } } }),
      applyContext,
    )

    expect(after.container.resourceLimits).toEqual({ cpu: 6, memory: '4g' })
    expect(after.container.runtimeSettings).toEqual(before.container.runtimeSettings)
    expect(before.container.resourceLimits).toEqual({ cpu: 2, memory: '4g' })
  })

  it('normalizes app clear semantics and owns the favicon timestamp', () => {
    const after = applySettingsPatch(
      currentSettings(),
      parsePatch({
        app: { hostBrowserProvider: null, faviconDataUrl: '' },
      }),
      applyContext,
    )

    expect(after.app?.hostBrowserProvider).toBeUndefined()
    expect(after.app?.faviconDataUrl).toBeUndefined()
    expect(after.app?.faviconUpdatedAt).toBe('2026-08-03T12:34:56.000Z')
  })

  it('applies API-key set/delete semantics without mutating the prior object', () => {
    const before = currentSettings()
    const after = applySettingsPatch(
      before,
      parsePatch({ apiKeys: { anthropicApiKey: '', genericApiKey: 'generic-new' } }),
      applyContext,
    )

    expect(after.apiKeys).toEqual({ openrouterApiKey: 'or-old', genericApiKey: 'generic-new' })
    expect(before.apiKeys).toEqual({ anthropicApiKey: 'sk-old', openrouterApiKey: 'or-old' })
  })

  it('resets models to provider defaults unless the patch supplies models explicitly', () => {
    const before = currentSettings()
    const defaults = applySettingsPatch(
      before,
      parsePatch({ llmProvider: 'bedrock' }),
      applyContext,
    )
    const explicit = applySettingsPatch(
      before,
      parsePatch({ llmProvider: 'bedrock', models: { agentModel: 'pinned-opus' } }),
      applyContext,
    )

    expect(defaults.models).toMatchObject({ agentModel: 'new-opus', browserModel: 'new-sonnet' })
    expect(explicit.models).toMatchObject({ agentModel: 'pinned-opus', browserModel: 'sonnet' })
  })

  it('preserves settings fields owned by other flows, including unknown future fields', () => {
    const before = {
      ...currentSettings(),
      futureOwnedSetting: { token: 'do-not-drop' },
    } as AppSettings & { futureOwnedSetting: { token: string } }

    const after = applySettingsPatch(
      before,
      parsePatch({ shareAnalytics: false }),
      applyContext,
    ) as AppSettings & { futureOwnedSetting: { token: string } }

    expect(after.platformAuth).toEqual(before.platformAuth)
    expect(after.futureOwnedSetting).toEqual({ token: 'do-not-drop' })
  })
})

describe('validateSettingsTransition', () => {
  function problemsFor(
    before: AppSettings,
    patchInput: unknown,
    context: Partial<SettingsTransitionContext> = {},
  ) {
    const patch = parsePatch(patchInput)
    const after = applySettingsPatch(before, patch, applyContext)
    return validateSettingsTransition({
      before,
      after,
      patch,
      context: { ...transitionContext, ...context },
    })
  }

  it('allows an unchanged merged resource limit while agents are running', () => {
    expect(
      problemsFor(currentSettings(), { container: { resourceLimits: { cpu: 2 } } }, {
        hasRunningAgents: true,
      }),
    ).toEqual([])
  })

  it('returns a 409 transition problem for an effective resource change', () => {
    expect(
      problemsFor(currentSettings(), { container: { resourceLimits: { cpu: 8 } } }, {
        hasRunningAgents: true,
      }),
    ).toContainEqual(expect.objectContaining({ status: 409, includeRunningAgentIds: true }))
  })

  it('rejects an image change for a runner whose image is deployment-managed', () => {
    expect(
      problemsFor(currentSettings(), {
        container: { containerRunner: 'lambda-microvm', agentImage: 'custom:v2' },
      }),
    ).toContainEqual(expect.objectContaining({ status: 400 }))
  })

  it('rejects a requested Lima VM size at or above host memory', () => {
    expect(
      problemsFor(
        currentSettings(),
        { container: { runtimeSettings: { lima: { vmMemory: '16GiB' } } } },
        { hostTotalMemoryBytes: 16 * 1024 ** 3 },
      ),
    ).toContainEqual(expect.objectContaining({ status: 400 }))
  })
})
