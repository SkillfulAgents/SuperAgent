import type { SkillsetConfig } from '@shared/lib/types/skillset'

export const DEFAULT_PUBLIC_SKILLSET: SkillsetConfig = {
  id: 'github-com-skillfulagents-public-skillset',
  url: 'https://github.com/SkillfulAgents/public-skillset',
  name: 'Gamut Public Skillset',
  description: 'A public collection of agent templates for the Gamut app.',
  addedAt: new Date(0).toISOString(),
  provider: 'public',
}
