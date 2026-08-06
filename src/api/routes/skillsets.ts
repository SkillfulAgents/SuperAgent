import { Hono } from 'hono'
import crypto from 'crypto'
import {
  getSettings,
  mutateSettings,
} from '@shared/lib/config/settings'
import { Authenticated, IsAdmin } from '../middleware/auth'
import {
  validateSkillsetUrl,
  urlToSkillsetId,
  refreshSkillset,
  getSkillsetIndex,
  removeSkillsetCache,
  ensureSkillsetCached,
  isGitAvailable,
} from '@shared/lib/services/skillset-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import type {
  SkillsetConfig,
  SkillsetCredential,
  SkillsetCredentialInput,
  SkillProvider,
} from '@shared/lib/types/skillset'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

async function resolveProvider(
  url: string,
  explicit?: SkillProvider,
  hasToken: boolean = false,
): Promise<SkillProvider | undefined> {
  if (hasToken) {
    if (explicit && explicit !== 'github') {
      throw new Error('Repository tokens are currently supported by the GitHub provider only.')
    }
    return 'github'
  }
  if (explicit) return explicit
  try {
    const hostname = new URL(url).hostname
    if (hostname === 'github.com' && !(await isGitAvailable())) {
      return 'public'
    }
  } catch {
    // invalid URL — let downstream validation handle it
  }
  return undefined
}

type SkillsetRequestBody = {
  url?: string
  provider?: SkillProvider
  token?: string
}

function parseToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('Token must be a string.')
  const token = value.trim()
  if (!token) return undefined
  if (token.length > 4096 || /\s/.test(token)) {
    throw new Error('Token must not contain whitespace and must be 4096 characters or fewer.')
  }
  return token
}

function tokenPreview(token: string): string {
  return `••••${token.slice(-4)}`
}

function createCredential(token: string, existing?: SkillsetCredential): SkillsetCredential {
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? `skillcred_${crypto.randomUUID()}`,
    type: 'token',
    token,
    tokenPreview: tokenPreview(token),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

function getCredentialId(config: Pick<SkillsetConfig, 'providerData'>): string | undefined {
  const id = config.providerData?.credentialId
  return typeof id === 'string' ? id : undefined
}

function transientCredential(token?: string): SkillsetCredentialInput | undefined {
  return token ? { type: 'token', token } : undefined
}

function toSkillsetRef(config: Pick<SkillsetConfig, 'id' | 'url' | 'name' | 'provider' | 'providerData'>) {
  const provider = getSkillsetProvider(config.provider)
  return {
    skillsetId: config.id,
    skillsetUrl: config.url,
    provider: config.provider,
    skillsetName: config.name,
    providerData: provider.normalizeProviderData(config),
  }
}

const skillsets = new Hono()

skillsets.use('*', Authenticated())

function configToApiResponse(config: SkillsetConfig, skillCount: number, agentCount: number = 0, error?: string): ApiSkillsetConfig {
  const provider = getSkillsetProvider(config.provider)
  const display = provider.getDisplayInfo()
  const credentialId = getCredentialId(config)
  const credential = credentialId ? getSettings().skillsetCredentials?.[credentialId] : undefined
  return {
    id: config.id,
    url: config.url,
    name: config.name,
    description: config.description,
    skillCount,
    agentCount,
    addedAt: config.addedAt,
    provider: config.provider,
    badgeLabel: display.badgeLabel,
    showUrl: display.showUrl,
    publishMode: provider.publishMode,
    credential: credential ? { type: credential.type, tokenPreview: credential.tokenPreview } : undefined,
    error,
  }
}

// GET /api/skillsets - List configured skillsets
skillsets.get('/', async (c) => {
  try {
    const configs = getSettings().skillsets || []
    const result: ApiSkillsetConfig[] = []

    for (const config of configs) {
      let index = await getSkillsetIndex(toSkillsetRef(config))
      let error: string | undefined
      if (!index) {
        try {
          await ensureSkillsetCached(toSkillsetRef(config))
          index = await getSkillsetIndex(toSkillsetRef(config))
        } catch (err) {
          error = err instanceof Error ? err.message : 'Failed to fetch skillset'
        }
      }
      result.push(configToApiResponse(config, index?.skills.length ?? 0, index?.agents?.length ?? 0, error))
    }

    return c.json(result)
  } catch (error) {
    console.error('Failed to list skillsets:', error)
    return c.json({ error: 'Failed to list skillsets' }, 500)
  }
})

// POST /api/skillsets/validate - Validate a skillset URL
skillsets.post('/validate', IsAdmin(), async (c) => {
  try {
    const { url, provider: explicitProvider, token: rawToken } = await c.req.json() as SkillsetRequestBody
    if (!url || typeof url !== 'string') {
      return c.json({ valid: false, error: 'URL is required' }, 400)
    }

    const token = parseToken(rawToken)
    const provider = await resolveProvider(url.trim(), explicitProvider, Boolean(token))
    const index = await validateSkillsetUrl(url.trim(), provider, transientCredential(token))
    return c.json({ valid: true, index })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate skillset URL'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/skillsets - Add a skillset (validates first)
skillsets.post('/', IsAdmin(), async (c) => {
  try {
    const { url, provider: explicitProvider, token: rawToken } = await c.req.json() as SkillsetRequestBody
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'URL is required' }, 400)
    }

    const trimmedUrl = url.trim()
    const token = parseToken(rawToken)
    const provider = await resolveProvider(trimmedUrl, explicitProvider, Boolean(token))
    const skillsetId = urlToSkillsetId(trimmedUrl)

    // Check for duplicates
    const settings = getSettings()
    const existing = settings.skillsets || []
    if (existing.some((s) => s.id === skillsetId)) {
      return c.json({ error: 'This skillset is already configured' }, 409)
    }

    // Validate and fetch index
    const index = await validateSkillsetUrl(trimmedUrl, provider, transientCredential(token))

    const credential = token ? createCredential(token) : undefined

    // Save to settings
    const config: SkillsetConfig = {
      id: skillsetId,
      url: trimmedUrl,
      name: index.skillset_name,
      description: index.description || '',
      addedAt: new Date().toISOString(),
      provider,
      providerData: credential ? { credentialId: credential.id } : undefined,
    }

    // Upsert by id against a FRESH read inside the serialized mutation so a
    // concurrent add of a different skillset isn't lost.
    mutateSettings((s) => {
      s.skillsets = [...(s.skillsets ?? []).filter((x) => x.id !== config.id), config]
      if (credential) {
        s.skillsetCredentials = { ...s.skillsetCredentials, [credential.id]: credential }
      }
    })

    return c.json(configToApiResponse(config, index.skills.length, index.agents?.length ?? 0), 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add skillset'
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/skillsets/:id - Remove a skillset
skillsets.delete('/:id', IsAdmin(), async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const existing = settings.skillsets || []
    const removed = existing.find((s) => s.id === id)
    const filtered = existing.filter((s) => s.id !== id)

    if (filtered.length === existing.length) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    // Remove from settings — filter against a FRESH read inside the serialized
    // mutation so a concurrent change to another skillset isn't lost.
    mutateSettings((s) => {
      const current = (s.skillsets ?? []).find((x) => x.id === id)
      s.skillsets = (s.skillsets ?? []).filter((x) => x.id !== id)
      const credentialId = current ? getCredentialId(current) : undefined
      if (credentialId && s.skillsetCredentials) {
        const remainingCredentials = { ...s.skillsetCredentials }
        delete remainingCredentials[credentialId]
        s.skillsetCredentials = remainingCredentials
      }
    })

    // Clean up cache
    await removeSkillsetCache(toSkillsetRef(existing.find((s) => s.id === id)!))

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove skillset:', error)
    return c.json({ error: 'Failed to remove skillset' }, 500)
  }
})

// PATCH /api/skillsets/:id/credential - Add, rotate, or remove a repository token
skillsets.patch('/:id/credential', IsAdmin(), async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json<{ token?: string | null }>()
    const config = (getSettings().skillsets || []).find((item) => item.id === id)
    if (!config) return c.json({ error: 'Skillset not found' }, 404)
    if (body.token === undefined) return c.json({ error: 'Token is required (use null to remove it)' }, 400)

    const previousCredentialId = getCredentialId(config)
    if (body.token === null || body.token === '') {
      mutateSettings((s) => {
        const target = (s.skillsets ?? []).find((item) => item.id === id)
        if (!target) return
        const providerData = { ...target.providerData }
        delete providerData.credentialId
        target.providerData = Object.keys(providerData).length ? providerData : undefined
        if (previousCredentialId && s.skillsetCredentials) {
          const remainingCredentials = { ...s.skillsetCredentials }
          delete remainingCredentials[previousCredentialId]
          s.skillsetCredentials = remainingCredentials
        }
      })
    } else {
      const token = parseToken(body.token)
      if (!token) return c.json({ error: 'Token cannot be empty (use null to remove it)' }, 400)
      const provider = await resolveProvider(config.url, config.provider, true)
      const index = await validateSkillsetUrl(config.url, provider, transientCredential(token))
      const existingCredential = previousCredentialId
        ? getSettings().skillsetCredentials?.[previousCredentialId]
        : undefined
      const credential = createCredential(token, existingCredential)

      mutateSettings((s) => {
        const target = (s.skillsets ?? []).find((item) => item.id === id)
        if (!target) return
        target.provider = provider
        target.providerData = { ...target.providerData, credentialId: credential.id }
        target.name = index.skillset_name
        target.description = index.description || ''
        s.skillsetCredentials = { ...s.skillsetCredentials, [credential.id]: credential }
      })
    }

    const updated = (getSettings().skillsets || []).find((item) => item.id === id)!
    const index = await getSkillsetIndex(toSkillsetRef(updated))
    return c.json(configToApiResponse(updated, index?.skills.length ?? 0, index?.agents?.length ?? 0))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update repository token'
    return c.json({ error: message }, 400)
  }
})

// POST /api/skillsets/:id/refresh - Refresh a skillset (git pull)
skillsets.post('/:id/refresh', IsAdmin(), async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)

    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const index = await refreshSkillset(toSkillsetRef(config))
    return c.json({ skills: index.skills })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh skillset'
    return c.json({ error: message }, 500)
  }
})

// GET /api/skillsets/:id/skills - Get skills from a specific skillset
skillsets.get('/:id/skills', async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)
    const index = config ? await getSkillsetIndex(toSkillsetRef(config)) : null

    if (!index) {
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    return c.json({ skills: index.skills })
  } catch (error) {
    console.error('Failed to get skillset skills:', error)
    return c.json({ error: 'Failed to get skillset skills' }, 500)
  }
})

// GET /api/skillsets/:id/agents - Get agents from a specific skillset
skillsets.get('/:id/agents', async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)
    const index = config ? await getSkillsetIndex(toSkillsetRef(config)) : null

    if (!index) {
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    return c.json({ agents: index.agents || [] })
  } catch (error) {
    console.error('Failed to get skillset agents:', error)
    return c.json({ error: 'Failed to get skillset agents' }, 500)
  }
})

// POST /api/skillsets/sync-remote - Auto-register remote skillsets from a provider
// Currently only 'platform' supports remote sync, but the route is provider-agnostic.
skillsets.post('/sync-remote', IsAdmin(), async (c) => {
  try {
    const body = await c.req.json<{ provider?: SkillProvider }>().catch(() => ({} as { provider?: SkillProvider }))
    const providerId = body.provider ?? 'platform'
    const provider = getSkillsetProvider(providerId)

    if (!provider.supportsRemoteSync) {
      return c.json({ error: `Provider '${providerId}' does not support remote sync` }, 400)
    }

    await provider.ensureSyncPreconditions()

    const remoteSkillsets = await provider.listRemoteSkillsets()
    if (!remoteSkillsets.length) {
      return c.json({ synced: 0, skillsets: [] })
    }

    // Build the new skillset list against a FRESH read inside the serialized
    // mutation so concurrent changes to unrelated skillsets aren't lost.
    const added: SkillsetConfig[] = []
    const finalSettings = mutateSettings((s) => {
      // Copy into a fresh array — never push() into whatever `s.skillsets` points
      // at. Defense-in-depth: even if a future change handed back a shared
      // default reference, this can't mutate it in place.
      const current = [...(s.skillsets ?? [])]
      for (const remote of remoteSkillsets) {
        const skillsetId = `${providerId}--${remote.repoId}--${remote.name}`

        const existingConfig = current.find((x) => x.id === skillsetId)
        if (existingConfig) {
          provider.updateSkillsetConfig(existingConfig, remote)
          continue
        }

        const config = provider.buildSkillsetConfig(remote)
        current.push(config)
        added.push(config)
      }
      s.skillsets = current
    })

    const allForProvider = (finalSettings.skillsets ?? []).filter((s) => s.provider === providerId)
    const cloned = new Set<string>()
    for (const config of allForProvider) {
      const configRef = toSkillsetRef(config)
      const cacheKey = provider.getEffectiveRepoId(configRef)
      if (!cloned.has(cacheKey)) {
        cloned.add(cacheKey)
        await ensureSkillsetCached(configRef)
      }
    }

    return c.json({ synced: added.length, skillsets: added.map((a) => a.name) })
  } catch (error) {
    console.error('Failed to sync remote skillsets:', error)
    const message = error instanceof Error ? error.message : 'Failed to sync remote skillsets'
    return c.json({ error: message }, 500)
  }
})

export default skillsets
