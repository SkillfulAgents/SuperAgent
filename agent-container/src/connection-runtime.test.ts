import { expect, it } from 'vitest'
import {
  cachedConnectionRuntime,
  rememberConnectionRuntime,
  runtimeFingerprint,
  type ConnectionRuntime,
} from './connection-runtime'

it('cannot reuse a warm process after an environment credential rotates without a DB generation change', () => {
  const old: ConnectionRuntime = {
    llmProviderId: 'same-account',
    generation: 3,
    provider: 'anthropic',
    model: 'model',
    browserModel: 'model',
    dashboardBuilderModel: 'model',
    modelPromptHints: [],
    subagentModels: [],
    modelContextWindows: {},
    env: { ANTHROPIC_API_KEY: 'old-key' },
  }
  rememberConnectionRuntime(old)
  const fingerprint = runtimeFingerprint(old)
  expect(cachedConnectionRuntime(old.llmProviderId, 3, 'model', fingerprint)).toEqual(old)
  const next = { ...old, env: { ANTHROPIC_API_KEY: 'new-key' } }
  rememberConnectionRuntime(next)
  expect(cachedConnectionRuntime(old.llmProviderId, 3, 'model', fingerprint)).toBeUndefined()
  expect(cachedConnectionRuntime(next.llmProviderId, 3, 'model', runtimeFingerprint(next))).toEqual(
    next
  )
  expect(
    cachedConnectionRuntime('another-account', 3, 'model', runtimeFingerprint(next))
  ).toBeUndefined()
})

it('strips subscription and every cloud auth mode before applying a different provider', async () => {
  const { withoutProviderCredentials } = await import('./connection-runtime')
  expect(withoutProviderCredentials({
    ANTHROPIC_API_KEY: 'api-key', ANTHROPIC_AUTH_TOKEN: 'bearer', ANTHROPIC_BASE_URL: 'https://old.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'subscription', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1', PLATFORM_AUTH_TOKEN: 'platform-services', PATH: '/usr/bin',
  })).toEqual({ PLATFORM_AUTH_TOKEN: 'platform-services', PATH: '/usr/bin' })
})
