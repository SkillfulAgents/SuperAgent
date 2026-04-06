import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getEffectiveSkillsetName } from '@shared/lib/utils/skillset-helpers'
import type { PlatformSubmitResult } from '@shared/lib/types/skillset'
import {
  BaseSkillsetProvider,
  type SkillsetHostedUpdateInput,
  type SkillsetRemoteDescriptor,
} from './base-skillset-provider'

export class PlatformSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'platform'
  readonly name = 'Platform'
  readonly publishMode = 'hosted_submit' as const
  readonly supportsRemoteSync = true

  override getEffectiveRepoId(skillsetId: string, platformRepoId?: string): string {
    return platformRepoId || skillsetId
  }

  override getRegistrationUrl(url: string): string {
    const proxyBase = getPlatformProxyBaseUrl()
    return proxyBase ? `${proxyBase}/v1/skills/repo` : url
  }

  override async resolveCloneUrl(url: string, options?: {
    skillsetId?: string
    skillsetName?: string
    platformRepoId?: string
  }): Promise<string> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      throw new Error('Platform not connected. Please connect to platform first.')
    }

    const skillsetName = options?.skillsetName
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

  override async submitUpdate(input: SkillsetHostedUpdateInput): Promise<PlatformSubmitResult> {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    if (!proxyBase || !token) {
      throw new Error('Platform not connected. Please connect to platform first.')
    }

    const skillsetName = getEffectiveSkillsetName(input) ?? input.skillsetId
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
        files: input.files,
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
}
