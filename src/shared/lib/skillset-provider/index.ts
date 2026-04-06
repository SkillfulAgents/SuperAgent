export { BaseSkillsetProvider } from './base-skillset-provider'
export type {
  SkillsetHostedUpdateFile,
  SkillsetHostedUpdateInput,
  SkillsetHostedUpdateType,
  SkillsetPublishMode,
  SkillsetRemoteDescriptor,
} from './base-skillset-provider'
export { GithubSkillsetProvider } from './github-provider'
export { PlatformSkillsetProvider } from './platform-provider'

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
