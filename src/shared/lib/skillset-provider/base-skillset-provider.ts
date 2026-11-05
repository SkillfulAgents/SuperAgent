import path from 'path'
import { directoryExists } from '@shared/lib/utils/file-storage'
import type { AppSettings } from '@shared/lib/config/settings'
import type {
  InstalledAgentMetadata,
  InstalledSkillMetadata,
  SkillProvider,
  SkillsetConfig,
  SkillsetCredentialInput,
  SkillsetProviderData,
} from '@shared/lib/types/skillset'

export type SkillsetPublishMode = 'pull_request' | 'hosted_submit' | 'none'

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
  /** Request-scoped secret for validation/add flows. Never serialize this ref. */
  credential?: SkillsetCredentialInput
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
  /** Obsolete repository files to remove as part of a GitHub update. */
  deletePaths?: string[]
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
  /** Request-scoped secret for validation/add flows. Never serialize this ref. */
  credential?: SkillsetCredentialInput
}

export type SkillsetSourceInfo = {
  skillsetName: string
  sourceLabel?: string
}

export type SkillsetDisplayInfo = {
  badgeLabel?: string
  showUrl: boolean
}

/**
 * The settings a provider judges a skillset record against (the platform
 * connection lives in them). Passed in rather than read, so the checks stay
 * synchronous inside a settings mutator and see the very settings it writes.
 */
export type SkillsetAuthSettings = Readonly<Pick<AppSettings, 'platformAuth'>>

export abstract class BaseSkillsetProvider {
  abstract readonly id: SkillProvider
  abstract readonly name: string
  abstract readonly publishMode: SkillsetPublishMode

  readonly supportsSuggestions: boolean = true
  readonly supportsRemoteSync: boolean = false
  readonly usesGitCache: boolean = true

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

  async isCacheReady(cacheDir: string): Promise<boolean> {
    return directoryExists(path.join(cacheDir, '.git'))
  }

  async populateCache(_cacheDir: string, _ref: SkillsetProviderRef): Promise<void> {
    throw new Error(`${this.name} provider does not implement populateCache`)
  }

  async refreshCache(_cacheDir: string, _ref: SkillsetProviderRef): Promise<void> {
    throw new Error(`${this.name} provider does not implement refreshCache`)
  }

  async resolveCloneUrl(url: string, _options?: SkillsetProviderRef): Promise<string> {
    return url
  }

  /** Add provider-specific authentication to a Git child process environment. */
  async getGitEnvironment(
    _ref: SkillsetProviderRef,
    baseEnvironment: NodeJS.ProcessEnv,
  ): Promise<NodeJS.ProcessEnv> {
    return baseEnvironment
  }

  /** Add provider-specific authentication to a provider CLI child process. */
  async getCliEnvironment(
    _ref: SkillsetProviderRef,
    baseEnvironment: NodeJS.ProcessEnv,
  ): Promise<NodeJS.ProcessEnv> {
    return baseEnvironment
  }

  async ensurePublishPreconditions(_ref?: SkillsetProviderRef): Promise<void> {}

  getRegistrationUrl(url: string): string {
    return url
  }

  abstract publishUpdate(input: SkillsetPublishInput): Promise<SkillsetPublishResult>

  async getQueueItemStatus(_queueItemId: string): Promise<string | null> {
    return null
  }

  /**
   * Batch variant of getQueueItemStatus. Default loops serially so existing
   * providers work untouched; platform overrides with a single batched fetch.
   *
   * Returns a Map keyed by queueItemId. Missing entries = status unknown /
   * still pending; non-null means the server returned a concrete status.
   */
  async getQueueItemStatuses(ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    for (const id of ids) {
      out.set(id, await this.getQueueItemStatus(id))
    }
    return out
  }

  /**
   * Whether a persisted SkillsetConfig is still valid for the auth state in
   * `settings`. Providers with no scoping (github) return true; platform
   * checks orgId match. Callers use this to reconcile settings after auth
   * changes.
   */
  isConfigValid(_config: SkillsetConfig, _settings: SkillsetAuthSettings): boolean {
    return true
  }

  /**
   * Whether an installed skill/agent-template metadata record is still valid
   * for the auth state in `settings`. Used for lazy cleanup on read.
   */
  isInstalledValid(
    _meta: Pick<InstalledSkillMetadata | InstalledAgentMetadata,
      'provider' | 'providerData'>,
    _settings: SkillsetAuthSettings,
  ): boolean {
    return true
  }

  async ensureSyncPreconditions(): Promise<void> {
    if (!this.supportsRemoteSync) {
      throw new Error(`${this.name} does not support remote sync`)
    }
  }

  async listRemoteSkillsets(): Promise<SkillsetRemoteDescriptor[]> {
    throw new Error(`${this.name} does not support remote sync`)
  }

  /** A config for a remote skillset, under the auth state in `settings`. */
  buildSkillsetConfig(remote: SkillsetRemoteDescriptor, _settings: SkillsetAuthSettings): SkillsetConfig {
    return {
      id: `${this.id}--${remote.repoId}--${remote.name}`,
      url: this.getRegistrationUrl(`${this.id}://skills/repo`),
      name: remote.name,
      description: remote.description || '',
      addedAt: new Date().toISOString(),
      provider: this.id,
    }
  }

  /** Update `existing` in place from `remote`, under the auth state in `settings`; true if it changed. */
  updateSkillsetConfig(
    existing: SkillsetConfig,
    remote: SkillsetRemoteDescriptor,
    _settings: SkillsetAuthSettings,
  ): boolean {
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
