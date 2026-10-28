import type { SkillsetConfig } from '@shared/lib/types/skillset'

export const DEFAULT_PUBLIC_SKILLSET: SkillsetConfig = {
  // id and url are frozen legacy identifiers: the id is exact-matched against persisted
  // per-agent skillset metadata (renaming orphans installed templates) and the url is the
  // actual cloned repo. Only the display name/description rebrand to Gamut in this batch.
  id: 'github-com-skillfulagents-public-skillset',
  url: 'https://github.com/SkillfulAgents/public-skillset',
  name: 'Gamut Public Skillset',
  description: 'A public collection of agent templates for the Gamut app.',
  addedAt: new Date(0).toISOString(),
  provider: 'public',
}
