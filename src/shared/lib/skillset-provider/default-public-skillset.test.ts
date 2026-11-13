import { describe, expect, it } from 'vitest'
import { DEFAULT_PUBLIC_SKILLSET, withCurrentDefaultLabels } from './default-public-skillset'

describe('withCurrentDefaultLabels', () => {
  it('brings a saved copy of the built-in library up to the current name', () => {
    const saved = { ...DEFAULT_PUBLIC_SKILLSET, name: 'Super Agent Public Skillset', description: 'old' }
    expect(withCurrentDefaultLabels(saved)).toMatchObject({
      name: DEFAULT_PUBLIC_SKILLSET.name,
      description: DEFAULT_PUBLIC_SKILLSET.description,
    })
  })

  it('leaves a library under the built-in id but another repo named by its owner', () => {
    const other = {
      ...DEFAULT_PUBLIC_SKILLSET,
      url: 'https://localhost.invalid/e2e-public-skillset',
      name: 'E2E Public Skillset',
    }
    expect(withCurrentDefaultLabels(other)).toBe(other)
  })

  it('leaves other libraries alone', () => {
    const team = { ...DEFAULT_PUBLIC_SKILLSET, id: 'team', name: 'Team Library' }
    expect(withCurrentDefaultLabels(team)).toBe(team)
  })
})
