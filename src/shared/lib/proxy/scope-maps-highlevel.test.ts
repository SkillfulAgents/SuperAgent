import { describe, it, expect } from 'vitest'
import { SCOPE_MAPS } from './scope-maps'
import { matchScopes } from './scope-matcher'

// The platform proxy refuses HighLevel's token endpoints (/oauth/*) and the
// app's own install and billing endpoints (/marketplace/*). A row for either
// would offer a policy for a call that can never succeed.
describe('SCOPE_MAPS.highlevel', () => {
  it('has no row the platform refuses', () => {
    const refused = SCOPE_MAPS.highlevel.scopeMap.filter(
      (e) => e.pathPattern.startsWith('/oauth/') || e.pathPattern.startsWith('/marketplace/'),
    )
    expect(refused).toEqual([])
  })

  it('matches the business-list call agents make first', () => {
    const result = matchScopes('highlevel', 'GET', '/locations/search')
    expect(result.matched).toBe(true)
    expect(result.scopes).toEqual(['locations.readonly'])
  })
})
