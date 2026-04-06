import { BaseSkillsetProvider } from './base-skillset-provider'
import { ensureGhAuthenticated } from '@shared/lib/utils/skillset-helpers'

export class GithubSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'github'
  readonly name = 'GitHub'
  readonly publishMode = 'pull_request' as const

  async ensurePublishPreconditions(): Promise<void> {
    await ensureGhAuthenticated()
  }
}
