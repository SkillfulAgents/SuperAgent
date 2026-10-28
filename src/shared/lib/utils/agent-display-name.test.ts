import { describe, expect, it } from 'vitest'
import { displayNameFromInstructions } from './agent-display-name'

describe('displayNameFromInstructions', () => {
  it('reads the display name from frontmatter', () => {
    expect(displayNameFromInstructions('---\nname: My Agent\n---\nBody')).toBe('My Agent')
  })

  it('coerces YAML-ambiguous names the parser turned into number/boolean', () => {
    expect(displayNameFromInstructions('---\nname: 123\n---\nBody')).toBe('123')
    expect(displayNameFromInstructions('---\nname: true\n---\nBody')).toBe('true')
  })

  it('returns undefined when the document or the name is missing', () => {
    expect(displayNameFromInstructions(null)).toBeUndefined()
    expect(displayNameFromInstructions('')).toBeUndefined()
    expect(displayNameFromInstructions('---\ndescription: no name\n---\nBody')).toBeUndefined()
    expect(displayNameFromInstructions('---\nname:\n---\nBody')).toBeUndefined()
  })
})
