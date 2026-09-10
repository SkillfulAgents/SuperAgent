import { describe, it, expect } from 'vitest'
import { SCOPE_MAPS } from './scope-maps'
import { getScopeLabel } from './scope-metadata'

// PLAID_ALLOWLIST in the platform toolkit bridge (apps/toolkit-bridge/src/adapters/plaid.ts).
// A path missing here is one the bridge would 404; a path here but not in the scope map
// is one the host would send to the policy layer with no scope. Update both together.
const BRIDGE_ALLOWLIST = [
  '/accounts/get',
  '/accounts/balance/get',
  '/transactions/sync',
  '/transactions/get',
  '/item/get',
  '/institutions/get_by_id',
]

describe('plaid scope map', () => {
  it('matches the bridge allowlist in both directions, POST only', () => {
    const rows = SCOPE_MAPS.plaid.scopeMap
    expect(rows.every((r) => r.method === 'POST')).toBe(true)
    const paths = rows.map((r) => r.pathPattern)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual([...BRIDGE_ALLOWLIST].sort())
  })

  it('declares every scope it uses, all labeled read', () => {
    const used = new Set(SCOPE_MAPS.plaid.scopeMap.flatMap((r) => r.sufficientScopes))
    expect([...used].sort()).toEqual([...(SCOPE_MAPS.plaid.allScopes as string[])].sort())
    for (const scope of used) expect(getScopeLabel('plaid', scope)).toBe('read')
  })
})
