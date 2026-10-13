import { describe, expect, it } from 'vitest'
import { overlapsChange } from './workspace-changes'

describe('overlapsChange', () => {
  it('refreshes a folder listing for a change at, above, or below it, and not beside it', () => {
    expect(overlapsChange('/workspace/out', ['/workspace/out/new.md'])).toBe(true)
    expect(overlapsChange('/workspace/out/deep', ['/workspace/out'])).toBe(true)
    expect(overlapsChange('/workspace/out', ['/workspace'])).toBe(true)
    expect(overlapsChange('/workspace/out', ['/workspace/outside.md'])).toBe(false)
  })
})
