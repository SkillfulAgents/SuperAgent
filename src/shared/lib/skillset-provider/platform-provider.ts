import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken, getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import type {
  InstalledAgentMetadata,
  InstalledSkillMetadata,
  PlatformSubmitResult,
  SkillsetConfig,
  SkillsetProviderData,
} from '@shared/lib/types/skillset'
import { validateSafeCloneUrl } from '@shared/lib/utils/url-safety'
import { captureException } from '@shared/lib/error-reporting'
import {
  BaseSkillsetProvider,
  type SkillsetHostedUpdateInput,
  type SkillsetPublishInput,
  type SkillsetPublishResult,
  type SkillsetProviderRef,
  type SkillsetRemoteDescriptor,
  type SkillsetSourceInfo,
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
    // TODO(skillset-platform, remove by 2026-06-30): compat bridge for older
    // persisted settings/metadata that used top-level platform* fields. All
    // writes now go through providerData; this branch can go once the
    // earliest supported client has rolled the fields forward at least once.
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

  override getSourceInfo(
    meta: SkillsetProviderRef,
    config?: SkillsetConfig,
  ): SkillsetSourceInfo {
    const configData = this.getPlatformData(config)
    const orgName = configData.orgName || this.getPlatformOrgName(config?.description)
    const skillsetName = config?.name || this.getSkillsetDisplayName(meta)
    return {
      skillsetName,
      sourceLabel: orgName ? `From org: ${orgName}` : skillsetName,
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
    if (!data.url) {
      throw new Error('Platform did not return a clone URL')
    }
    // Validate: http(s) only, no private/loopback/link-local hosts, and
    // only on hosts we trust. The clone URL may live on a separate git
    // storage host (e.g. datawizz.code.storage) rather than the proxy
    // itself, so we allowlist both.
    const proxyOrigin = (() => {
      try { return new URL(proxyBase).origin } catch { return undefined }
    })()
    const cloneOrigin = (() => {
      try { return new URL(data.url).origin } catch { return undefined }
    })()
    const allowedPrefixes = [proxyOrigin, cloneOrigin].filter((o): o is string => !!o)
    validateSafeCloneUrl(data.url, {
      allowedHostPrefixes: allowedPrefixes.length > 0 ? allowedPrefixes : undefined,
    })

    return data.url
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
    const map = await this.getQueueItemStatuses([queueItemId])
    return map.get(queueItemId) ?? null
  }

  override async getQueueItemStatuses(ids: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>()
    if (ids.length === 0) return result

    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      for (const id of ids) result.set(id, null)
      return result
    }

    try {
      const res = await fetch(`${proxyBase}/v1/skills/queue/batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids }),
      })
      if (res.ok) {
        const data = await res.json() as { items?: Record<string, { status?: string } | null> }
        const items = data.items ?? {}
        for (const id of ids) {
          const item = items[id]
          result.set(id, item?.status ?? null)
        }
        return result
      }
      // Server doesn't support batch (older proxy) — fall through to per-id.
    } catch (error) {
      captureException(error, { tags: { area: 'skillset-platform', op: 'queue-batch' } })
    }

    await Promise.all(ids.map(async (id) => {
      try {
        const res = await fetch(`${proxyBase}/v1/skills/queue/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          result.set(id, null)
          return
        }
        const data = await res.json() as { item?: { status?: string } }
        result.set(id, data.item?.status ?? null)
      } catch (error) {
        captureException(error, { tags: { area: 'skillset-platform', op: 'queue-item' } })
        result.set(id, null)
      }
    }))
    return result
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
    const nextFields: PlatformProviderData = {
      repoId: remote.repoId,
      ...(auth.orgId ? { orgId: auth.orgId } : {}),
      ...(auth.orgName ? { orgName: auth.orgName } : {}),
    }
    if (
      current.repoId !== nextFields.repoId
      || current.orgId !== nextFields.orgId
      || current.orgName !== nextFields.orgName
    ) {
      // Merge, don't replace — preserve any unrelated fields a newer platform
      // version may have added that this client doesn't know about.
      existing.providerData = {
        ...(existing.providerData ?? {}),
        ...nextFields,
      }
      changed = true
    }
    return changed
  }

  override isConfigValid(config: SkillsetConfig): boolean {
    if (config.provider !== 'platform') return true
    const auth = getPlatformAuthStatus()
    const currentOrgId = auth.orgId ?? null
    const configOrgId = this.getPlatformData(config).orgId ?? null
    // If the user isn't signed in, no platform configs are valid.
    if (!currentOrgId) return false
    return configOrgId === currentOrgId
  }

  override isInstalledValid(
    meta: Pick<InstalledSkillMetadata | InstalledAgentMetadata, 'provider' | 'providerData'>,
  ): boolean {
    if (meta.provider !== 'platform') return true
    const auth = getPlatformAuthStatus()
    const currentOrgId = auth.orgId ?? null
    const metaOrgId = this.getPlatformData(meta).orgId ?? null
    if (!currentOrgId) return false
    return metaOrgId === currentOrgId
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

  private getPlatformOrgName(description?: string): string | undefined {
    if (!description) return undefined
    const prefix = 'Default skillset for '
    if (!description.startsWith(prefix)) return undefined
    return description.slice(prefix.length).trim() || undefined
  }
}
