import type {
  SkillProvider,
  SkillsetConfig,
  SkillsetProviderData,
} from '@shared/lib/types/skillset'

export type SkillsetPublishMode = 'pull_request' | 'hosted_submit'

export type SkillsetHostedUpdateType = 'skill' | 'agent'

export type SkillsetHostedUpdateFile = {
  path: string
  content: string
}

export type SkillsetHostedUpdateInput = {
  skillsetId: string
  skillsetUrl: string
  skillsetName?: string
  providerData?: SkillsetProviderData
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
  prUrl?: string
  successMessage: string
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

export type SkillsetProviderRef = {
  skillsetId: string
  skillsetUrl?: string
  skillsetName?: string
  providerData?: SkillsetProviderData
}

export type SkillsetSourceInfo = {
  skillsetName: string
  sourceLabel?: string
}

export type SkillsetDisplayInfo = {
  badgeLabel?: string
  showUrl: boolean
}

export abstract class BaseSkillsetProvider {
  abstract readonly id: SkillProvider
  abstract readonly name: string
  abstract readonly publishMode: SkillsetPublishMode

  readonly supportsSuggestions: boolean = true
  readonly supportsRemoteSync: boolean = false

  normalizeProviderData(source?: { providerData?: SkillsetProviderData } | null): SkillsetProviderData | undefined {
    return source?.providerData
  }

  getEffectiveRepoId(ref: SkillsetProviderRef): string {
    return ref.skillsetId
  }

  getSkillsetDisplayName(ref: Pick<SkillsetProviderRef, 'skillsetId' | 'skillsetName'>): string {
    return ref.skillsetName || ref.skillsetId
  }

  getSourceInfo(
    meta: SkillsetProviderRef,
    config?: SkillsetConfig,
  ): SkillsetSourceInfo {
    const skillsetName = config?.name || this.getSkillsetDisplayName(meta)
    return { skillsetName, sourceLabel: skillsetName }
  }

  getDisplayInfo(): SkillsetDisplayInfo {
    return { showUrl: true }
  }

  async resolveCloneUrl(url: string, _options?: SkillsetProviderRef): Promise<string> {
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
