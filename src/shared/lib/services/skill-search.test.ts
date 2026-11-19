import { describe, expect, it } from 'vitest'
import type { DiscoverableSkill } from '@shared/lib/types/skillset'
import { matchSkills } from './skill-search'

function skill(name: string, description: string, skillsetName = 'Team Skills'): DiscoverableSkill {
  return { skillsetId: 'platform--team', skillsetName, name, description, version: '1.0.0', path: `skills/${name}/SKILL.md` }
}

const skills = [
  skill('expense-report', 'Build the monthly expense report from card exports'),
  skill('invoice-parser', 'Read fields from invoice PDFs'),
  skill('pdf-merge', 'Join several PDF files into one'),
  skill('weekly-digest', 'Summarize the week for the team', 'Finance Ops'),
]

const names = (found: DiscoverableSkill[]) => found.map((s) => s.name)

describe('matchSkills', () => {
  it('keeps every skill in the given order when there is no query', () => {
    expect(matchSkills(skills, undefined)).toEqual(skills)
    expect(matchSkills(skills, '  ')).toEqual(skills)
  })

  it('matches a word in the name, the description or the skillset name, in any letter case', () => {
    expect(names(matchSkills(skills, 'Invoice'))).toEqual(['invoice-parser'])
    expect(names(matchSkills(skills, 'card'))).toEqual(['expense-report'])
    expect(names(matchSkills(skills, 'finance'))).toEqual(['weekly-digest'])
  })

  it('needs only one of the query words and puts the skill with more matches first', () => {
    expect(names(matchSkills(skills, 'merge invoice pdf'))).toEqual(['pdf-merge', 'invoice-parser'])
  })

  it('ranks a match in the name above a match in the description', () => {
    expect(names(matchSkills(skills, 'pdf'))).toEqual(['pdf-merge', 'invoice-parser'])
  })

  it('returns nothing when no word matches', () => {
    expect(matchSkills(skills, 'calendar')).toEqual([])
  })
})
