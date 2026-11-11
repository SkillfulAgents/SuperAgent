import type { SkillsetConfig } from '@shared/lib/types/skillset'

export const DEFAULT_PUBLIC_SKILLSET: SkillsetConfig = {
  // id and url are frozen legacy identifiers: the id is exact-matched against persisted
  // per-agent skillset metadata (renaming orphans installed templates) and the url is the
  // actual cloned repo. The name and description are display copy and may change freely —
  // `withCurrentDefaultLabels` keeps every install's saved copy in step with them.
  id: 'github-com-skillfulagents-public-skillset',
  url: 'https://github.com/SkillfulAgents/public-skillset',
  name: 'Gamut Community',
  description: 'A public collection of agent templates for the Gamut app.',
  addedAt: new Date(0).toISOString(),
  provider: 'public',
}

/**
 * The built-in library's name and description belong to the app, not to the
 * install: settings.json saves whatever they were when the install was created,
 * so without this a rename (Super Agent → Gamut → Library) never reaches anyone
 * who already has it. Other libraries are named by their owners and pass through
 * — including one saved under the built-in id but pointing at another repo
 * (the e2e seed does this), since then it isn't the built-in library at all.
 */
export function withCurrentDefaultLabels(skillset: SkillsetConfig): SkillsetConfig {
  if (skillset.id !== DEFAULT_PUBLIC_SKILLSET.id || skillset.url !== DEFAULT_PUBLIC_SKILLSET.url) return skillset
  return {
    ...skillset,
    name: DEFAULT_PUBLIC_SKILLSET.name,
    description: DEFAULT_PUBLIC_SKILLSET.description,
  }
}
