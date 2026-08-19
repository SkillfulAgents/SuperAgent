import { describe, expect, it } from 'vitest'
import { parseSkillsetIndex } from './skillset-schema'

/**
 * `index.json` comes from a git repo anyone can add, and a parse failure is not
 * recoverable downstream: `getSkillsetIndex` turns the throw into `null`, which
 * drops the skillset out of Explore AND out of skill discovery with nothing
 * shown to the user. So the split matters — the envelope is fatal, individual
 * entries are not.
 */
describe('parseSkillsetIndex', () => {
  it('rejects a document with no skillset_name, naming the field', () => {
    const result = parseSkillsetIndex({ skills: [] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a rejection')
    expect(result.error).toContain('skillset_name')
  })

  it('keeps the good entries and reports the ones it drops', () => {
    const result = parseSkillsetIndex({
      skillset_name: 'Public',
      skills: [
        { name: 'query', path: 'skills/query/SKILL.md' },
        { name: 'no-path' },
      ],
      agents: [
        { name: 'Research Bot', path: 'agents/research-bot/' },
        { name: 'Bad Tags', path: 'agents/bad-tags/', tags: 'one,two' },
        { name: 'Bad Connection', path: 'agents/bad-conn/', works_with: [{ slug: 'slack' }] },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.index.skills.map((s) => s.name)).toEqual(['query'])
    expect(result.index.agents?.map((a) => a.name)).toEqual(['Research Bot'])
    // Each drop says which list, which row, and which field — one malformed
    // entry among 168 is otherwise unfindable.
    expect(result.dropped).toHaveLength(3)
    expect(result.dropped[0]).toContain('skills[1]')
    expect(result.dropped[0]).toContain('path')
    expect(result.dropped[1]).toContain('agents[1]')
    expect(result.dropped[1]).toContain('tags')
    expect(result.dropped[2]).toContain('agents[2]')
  })

  it('reports nothing dropped for a clean index', () => {
    const result = parseSkillsetIndex({
      skillset_name: 'Public',
      skills: [],
      agents: [{ name: 'A', path: 'agents/a/' }],
    })
    expect(result.ok && result.dropped).toEqual([])
  })

  it('keeps the marketplace fields, including the snake_case ones', () => {
    const result = parseSkillsetIndex({
      skillset_name: 'Public',
      skills: [],
      agents: [
        {
          name: 'A',
          path: 'agents/a/',
          category: 'Marketing',
          icon: 'megaphone',
          tags: ['seo'],
          works_with: [{ type: 'api_account', slug: 'slack' }],
          developer: { name: 'SkillfulAgents', url: 'https://github.com/SkillfulAgents' },
          details: '## What it does\n\nThings.',
        },
      ],
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.index.agents?.[0]).toMatchObject({
      category: 'Marketing',
      icon: 'megaphone',
      tags: ['seo'],
      works_with: [{ type: 'api_account', slug: 'slack' }],
      developer: { name: 'SkillfulAgents' },
    })
  })

  it('still loads a skillset on the pre-marketplace shape', () => {
    const result = parseSkillsetIndex({
      skillset_name: 'Public',
      description: 'old',
      version: '1.0.0',
      skills: [{ name: 'query', path: 'skills/query/SKILL.md', description: 'd', version: '1' }],
      agents: [{ name: 'A', path: 'agents/a/', description: 'd', version: '1' }],
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.index.agents).toHaveLength(1)
    expect(result.index.agents?.[0].category).toBeUndefined()
    expect(result.dropped).toEqual([])
  })

  it('drops unknown keys rather than rejecting them', () => {
    const result = parseSkillsetIndex({
      skillset_name: 'Public',
      skills: [],
      agents: [{ name: 'A', path: 'agents/a/', future_field: { a: 1 } }],
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.index.agents?.[0]).not.toHaveProperty('future_field')
    expect(result.dropped).toEqual([])
  })
})
