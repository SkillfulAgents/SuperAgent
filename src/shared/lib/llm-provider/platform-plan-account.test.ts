import { beforeEach, expect, it, vi } from 'vitest'
import { mutateSettings, type PlatformAuthSettings } from '@shared/lib/config/settings'
import { platformPlanCache } from './platform-plan-cache'
import { actingPlanCacheKey, actingPlanPolicy } from './platform-plan-account'

// The account each token belongs to, and its plan. A read without a token
// (the old loader) gets the account connected now.
const state = vi.hoisted(() => ({ currentToken: null as string | null }))
const accounts: Record<string, { plan: { name: string }; deniedModels: string[] }> = {
  plat_token_a: { plan: { name: 'Plan A' }, deniedModels: ['model-only-b-may-use'] },
  plat_token_b: { plan: { name: 'Plan B' }, deniedModels: [] },
}
const fetchAccount = vi.hoisted(() => vi.fn())

vi.mock('@shared/lib/services/platform-auth-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/services/platform-auth-service')>()),
  fetchActingPlatformAccount: fetchAccount,
}))

function record(token: string, orgId: string, memberId: string): PlatformAuthSettings {
  const now = new Date().toISOString()
  return {
    token, tokenPreview: `${token.slice(0, 6)}...`, email: null, label: null,
    orgId, orgName: null, role: null, userId: null, memberId, createdAt: now, updatedAt: now,
  }
}

beforeEach(() => {
  platformPlanCache.clear()
  fetchAccount.mockReset()
  fetchAccount.mockImplementation(async (token?: string | null) => accounts[(token === undefined ? state.currentToken : token) ?? ''])
})

it('reads the policy with the connection the operation keyed on, not one switched since', async () => {
  const operationSettings = { platformAuth: record('plat_token_a', 'org_a', 'sub_a') }
  // Another process connects account B after this operation read its settings.
  await mutateSettings((s) => { s.platformAuth = record('plat_token_b', 'org_b', 'sub_b') })
  state.currentToken = 'plat_token_b'
  const acting = async () => null

  const policy = await actingPlanPolicy({ settings: operationSettings, acting })

  expect(fetchAccount).toHaveBeenCalledWith('plat_token_a')
  expect(policy).toEqual({ planName: 'Plan A', deniedModels: ['model-only-b-may-use'] })
  // A later operation of account A, served from the cache, gets A's restrictions.
  fetchAccount.mockClear()
  expect(await actingPlanPolicy({ settings: operationSettings, acting })).toEqual(policy)
  expect(fetchAccount).not.toHaveBeenCalled()
  expect(await actingPlanCacheKey({ settings: operationSettings, acting }))
    .not.toBe(await actingPlanCacheKey({ settings: { platformAuth: record('plat_token_b', 'org_b', 'sub_b') }, acting }))
})
