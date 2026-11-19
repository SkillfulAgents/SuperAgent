import type { DiscoverableSkill } from '@shared/lib/types/skillset'

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * The skills that match a free-text query, best match first. A skill matches when any word of
 * the query appears in its name, its description or its skillset's name; a word found in the
 * name counts double. An empty query keeps every skill, in the order given.
 */
export function matchSkills(skills: DiscoverableSkill[], query: string | undefined): DiscoverableSkill[] {
  const words = [...new Set(wordsOf(query ?? ''))]
  if (words.length === 0) return skills

  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase()
      const rest = `${skill.description} ${skill.skillsetName}`.toLowerCase()
      let score = 0
      for (const word of words) {
        if (name.includes(word)) score += 2
        else if (rest.includes(word)) score += 1
      }
      return { skill, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.skill)
}
