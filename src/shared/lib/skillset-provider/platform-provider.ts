import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken, getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import type {
  PlatformSubmitResult,
  SkillsetConfig,
  SkillsetProviderData,
} from '@shared/lib/types/skillset'
import {
  BaseSkillsetProvider,
  type SkillsetAccessInfo,
  type SkillsetHostedUpdateInput,
  type SkillsetPublishInput,
  type SkillsetPublishResult,
  type SkillsetProviderRef,
  type SkillsetRemoteDescriptor,
} from './base-skillset-provider'

type PlatformProviderData = {
  repoId?: string
  orgId?: string
  orgName?: string
}

export class PlatformSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'platform'
  readonly name = 'Platform'
  readonly publishMode = 'hosted_submit' as const
  readonly supportsRemoteSync = true

  override normalizeProviderData(source?: { providerData?: SkillsetProviderData } | null): SkillsetProviderData | undefined {
    const providerData = source?.providerData
    const record = source as Record<string, unknown> | undefined
    // Temporary compatibility bridge while older persisted settings/metadata
    // still use top-level platform* fields.
    const repoId = this.readString(providerData?.repoId) ?? this.readString(record?.platformRepoId)
    const orgId = this.readString(providerData?.orgId) ?? this.readString(record?.platformOrgId)
    const orgName = this.readString(providerData?.orgName) ?? this.readString(record?.platformOrgName)
    if (!repoId && !orgId && !orgName) return undefined
    return {
      ...(repoId ? { repoId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(orgName ? { orgName } : {}),
    }
  }

  override getEffectiveRepoId(ref: SkillsetProviderRef): string {
    return this.getPlatformData(ref).repoId || ref.skillsetId
  }

  override getSkillsetDisplayName(ref: Pick<SkillsetProviderRef, 'skillsetId' | 'skillsetName' | 'providerData'>): string {
    return ref.skillsetName
      || this.getPlatformData(ref).repoId?.split('/').pop()
      || ref.skillsetId
  }

  override getAccessInfo(params: {
    currentContext?: Record<string, unknown>
    config?: Pick<SkillsetConfig, 'name' | 'description' | 'providerData'>
    meta: Pick<SkillsetProviderRef, 'skillsetId' | 'skillsetName' | 'providerData'>
  }): SkillsetAccessInfo {
    const configData = this.getPlatformData(params.config)
    const metaData = this.getPlatformData(params.meta)
    const orgId = configData.orgId || this.getOrgIdFromRepoId(configData.repoId) || this.getOrgIdFromRepoId(metaData.repoId)
    const orgName = configData.orgName || this.getPlatformOrgName(params.config?.description)
    const skillsetName = params.config?.name || this.getSkillsetDisplayName(params.meta)
    const currentPlatformOrgId = typeof params.currentContext?.platformOrgId === 'string'
      ? params.currentContext.platformOrgId
      : undefined
    return {
      skillsetName,
      sourceLabel: orgName ? `From org: ${orgName}` : skillsetName,
      isAccessible: !orgId || orgId === currentPlatformOrgId,
    }
  }

  override getDisplayInfo() {
    return { badgeLabel: 'Platform', showUrl: false }
  }

  override getRegistrationUrl(url: string): string {
    const proxyBase = getPlatformProxyBaseUrl()
    return proxyBase ? `${proxyBase}/v1/skills/repo` : url
  }

  override async resolveCloneUrl(url: string, options?: SkillsetProviderRef): Promise<string> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      throw new Error('Platform not connected. Please connect to platform first.')
    }

    const skillsetName = options
      ? this.getSkillsetDisplayName({
        skillsetId: options.skillsetId,
        skillsetName: options.skillsetName,
        providerData: options.providerData,
      })
      : undefined
    if (!skillsetName) {
      throw new Error('skillsetName is required for platform provider')
    }

    const fetchUrl = `${proxyBase}/v1/skills/git-url?skillset=${encodeURIComponent(skillsetName)}`
    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      throw new Error(`Failed to get platform Git URL: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as { url: string; defaultBranch: string }
    try {
      const parsed = new URL(data.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Unsafe clone URL protocol: ${parsed.protocol}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsafe clone URL')) {
        throw error
      }
      throw new Error(`Invalid clone URL returned by platform: ${data.url}`)
    }

    return data.url || url
  }

  override async publishUpdate(input: SkillsetPublishInput): Promise<SkillsetPublishResult> {
    const result = await this.submitUpdate(input)
    if (result.status === 'rejected') {
      throw new Error('This upload was rejected by the platform. Review the changes and try again.')
    }
    return {
      successMessage: 'Changes submitted successfully.',
      status: result.status,
      queueItem: result.queueItem,
    }
  }

  private async submitUpdate(input: SkillsetHostedUpdateInput): Promise<PlatformSubmitResult> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      throw new Error('Platform not connected. Please connect to platform first.')
    }

    const skillsetName = this.getSkillsetDisplayName(input)
    const res = await fetch(`${proxyBase}/v1/skills/submit-update`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        skillsetName,
        targetName: input.targetName,
        targetType: input.targetType,
        files: input.files?.filter((f) => f.path !== 'index.json'),
        title: input.title,
        message: input.message,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Platform submit failed: ${res.status} ${body}`)
    }

    return await res.json() as PlatformSubmitResult
  }

  override async getQueueItemStatus(queueItemId: string): Promise<string | null> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) return null

    try {
      const res = await fetch(`${proxyBase}/v1/skills/queue/${encodeURIComponent(queueItemId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null

      const data = await res.json() as { item: { status: string } }
      return data.item?.status ?? null
    } catch {
      return null
    }
  }

  override async listRemoteSkillsets(): Promise<SkillsetRemoteDescriptor[]> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      throw new Error('Platform not connected. Please connect to platform first.')
    }

    const res = await fetch(`${proxyBase}/v1/skills/skillsets`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch platform skillsets: ${res.status}`)
    }

    const data = await res.json() as {
      skillsets: Array<{
        name: string
        repoId: string
        description: string
        skill_count: number
        agent_count: number
      }>
    }

    return (data.skillsets || []).map((skillset) => ({
      name: skillset.name,
      repoId: skillset.repoId,
      description: skillset.description || '',
      skillCount: skillset.skill_count,
      agentCount: skillset.agent_count,
    }))
  }

  override async ensureSyncPreconditions(): Promise<void> {
    const auth = getPlatformAuthStatus()
    if (!auth.connected) {
      throw new Error('Platform not connected')
    }
  }

  override buildSkillsetConfig(remote: SkillsetRemoteDescriptor): SkillsetConfig {
    const auth = getPlatformAuthStatus()
    return {
      ...super.buildSkillsetConfig(remote),
      providerData: {
        repoId: remote.repoId,
        ...(auth.orgId ? { orgId: auth.orgId } : {}),
        ...(auth.orgName ? { orgName: auth.orgName } : {}),
      },
    }
  }

  override updateSkillsetConfig(existing: SkillsetConfig, remote: SkillsetRemoteDescriptor): boolean {
    let changed = super.updateSkillsetConfig(existing, remote)
    const auth = getPlatformAuthStatus()
    const current = this.getPlatformData(existing)
    const next: PlatformProviderData = {
      repoId: remote.repoId,
      ...(auth.orgId ? { orgId: auth.orgId } : {}),
      ...(auth.orgName ? { orgName: auth.orgName } : {}),
    }
    if (
      current.repoId !== next.repoId
      || current.orgId !== next.orgId
      || current.orgName !== next.orgName
    ) {
      existing.providerData = next
      changed = true
    }
    return changed
  }

  private getPlatformData(source?: { providerData?: SkillsetProviderData } | null): PlatformProviderData {
    const providerData = this.normalizeProviderData(source)
    return {
      repoId: this.readString(providerData?.repoId),
      orgId: this.readString(providerData?.orgId),
      orgName: this.readString(providerData?.orgName),
    }
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  private getOrgIdFromRepoId(repoId?: string): string | undefined {
    if (!repoId) return undefined
    const parts = repoId.split('/')
    return parts.length >= 3 ? parts[1] : undefined
  }

  private getPlatformOrgName(description?: string): string | undefined {
    if (!description) return undefined
    const prefix = 'Default skillset for '
    if (!description.startsWith(prefix)) return undefined
    return description.slice(prefix.length).trim() || undefined
  }
}
