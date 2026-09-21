import { expect, it } from 'vitest'
import {
  cachedConnectionRuntime,
  rememberConnectionRuntime,
  runtimeFingerprint,
  type ConnectionRuntime,
} from './connection-runtime'

it('cannot reuse a warm process after an environment credential rotates without a DB generation change', () => {
  const old: ConnectionRuntime = {
    connectionId: 'same-account',
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
  expect(cachedConnectionRuntime(old.connectionId, 3, 'model', fingerprint)).toEqual(old)
  const next = { ...old, env: { ANTHROPIC_API_KEY: 'new-key' } }
  rememberConnectionRuntime(next)
  expect(cachedConnectionRuntime(old.connectionId, 3, 'model', fingerprint)).toBeUndefined()
  expect(cachedConnectionRuntime(next.connectionId, 3, 'model', runtimeFingerprint(next))).toEqual(
    next
  )
  expect(
    cachedConnectionRuntime('another-account', 3, 'model', runtimeFingerprint(next))
  ).toBeUndefined()
})
