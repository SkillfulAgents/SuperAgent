import type {
  PlatformSubmitResult,
  SkillProvider,
} from '@shared/lib/types/skillset'

export type SkillsetPublishMode = 'pull_request' | 'hosted_submit' | 'read_only'

export type SkillsetHostedUpdateType = 'skill' | 'agent'

export type SkillsetHostedUpdateFile = {
  path: string
  content: string
}

export type SkillsetHostedUpdateInput = {
  skillsetId: string
  skillsetUrl: string
  skillsetName?: string
  platformRepoId?: string
  targetName: string
  targetType: SkillsetHostedUpdateType
  files: SkillsetHostedUpdateFile[]
  title: string
  message: string
}

export type SkillsetRemoteDescriptor = {
  name: string
  repoId: string
  description: string
  skillCount: number
  agentCount: number
}

export abstract class BaseSkillsetProvider {
  abstract readonly id: SkillProvider
  abstract readonly name: string
  abstract readonly publishMode: SkillsetPublishMode

  readonly supportsSuggestions: boolean = true
  readonly supportsRemoteSync: boolean = false

  getEffectiveRepoId(skillsetId: string, _platformRepoId?: string): string {
    return skillsetId
  }

  async resolveCloneUrl(url: string, _options?: {
    skillsetId?: string
    skillsetName?: string
    platformRepoId?: string
  }): Promise<string> {
    return url
  }

  async ensurePublishPreconditions(): Promise<void> {}

  getRegistrationUrl(url: string): string {
    return url
  }

  async submitUpdate(_input: SkillsetHostedUpdateInput): Promise<PlatformSubmitResult> {
    throw new Error(`${this.name} does not support hosted submissions`)
  }

  async getQueueItemStatus(_queueItemId: string): Promise<string | null> {
    return null
  }

  async listRemoteSkillsets(): Promise<SkillsetRemoteDescriptor[]> {
    throw new Error(`${this.name} does not support remote sync`)
  }
}
