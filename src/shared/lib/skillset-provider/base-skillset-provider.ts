import type {
  SkillProvider,
  SkillsetConfig,
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

export type SkillsetPublishInput = {
  repoDir: string
  branchPrefix: string
  files: SkillsetHostedUpdateFile[]
  title: string
  body: string
  gitAddPaths?: string[]
} & SkillsetHostedUpdateInput

export type SkillsetPublishResult = {
  prUrl: string
  status?: string
  queueItem?: { id: string; branch_name: string; status: string }
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

  abstract publishUpdate(input: SkillsetPublishInput): Promise<SkillsetPublishResult>

  async getQueueItemStatus(_queueItemId: string): Promise<string | null> {
    return null
  }

  async ensureSyncPreconditions(): Promise<void> {
    if (!this.supportsRemoteSync) {
      throw new Error(`${this.name} does not support remote sync`)
    }
  }

  async listRemoteSkillsets(): Promise<SkillsetRemoteDescriptor[]> {
    throw new Error(`${this.name} does not support remote sync`)
  }

  buildSkillsetConfig(remote: SkillsetRemoteDescriptor): SkillsetConfig {
    return {
      id: `${this.id}--${remote.repoId}--${remote.name}`,
      url: this.getRegistrationUrl(`${this.id}://skills/repo`),
      name: remote.name,
      description: remote.description || '',
      addedAt: new Date().toISOString(),
      provider: this.id,
    }
  }

  updateSkillsetConfig(existing: SkillsetConfig, remote: SkillsetRemoteDescriptor): boolean {
    let changed = false
    if (existing.name !== remote.name) {
      existing.name = remote.name
      changed = true
    }
    if (existing.description !== (remote.description || '')) {
      existing.description = remote.description || ''
      changed = true
    }
    return changed
  }
}
