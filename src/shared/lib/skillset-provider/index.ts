import type { SkillProvider } from '@shared/lib/types/skillset'
import { BaseSkillsetProvider } from './base-skillset-provider'
import { GithubSkillsetProvider } from './github-provider'
import { PlatformSkillsetProvider } from './platform-provider'

const providers: Record<SkillProvider, BaseSkillsetProvider> = {
  github: new GithubSkillsetProvider(),
  platform: new PlatformSkillsetProvider(),
}

export function getSkillsetProvider(provider?: SkillProvider): BaseSkillsetProvider {
  return providers[provider ?? 'github']
}
