import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import { getAgentsDir } from '@shared/lib/utils/file-storage'
import type { SkillsetConfig, InstalledSkillMetadata, InstalledAgentMetadata } from '@shared/lib/types/skillset'

import {
  getPlatformAccessToken,
  savePlatformAuth,
  revokePlatformToken,
} from './platform-auth-service'

describe('platform-auth-service', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-platform-auth-'))
    process.env.SUPERAGENT_DATA_DIR = tempDir
    clearSettingsCache()
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tempDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  })

  it('falls back to PLATFORM_TOKEN env in auth mode when settings have no record', () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = 'env-managed-platform-token'

    expect(getPlatformAccessToken('local')).toBe('env-managed-platform-token')

    delete process.env.PLATFORM_TOKEN
    delete process.env.AUTH_MODE
  })

  it('returns null when not in auth mode and no settings record exists', () => {
    process.env.PLATFORM_TOKEN = 'should-be-ignored-when-auth-mode-off'
    delete process.env.AUTH_MODE

    expect(getPlatformAccessToken('local')).toBeNull()

    delete process.env.PLATFORM_TOKEN
  })

  it('stores a token and exposes only redacted status', async () => {
    const status = await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })

    expect(status).toMatchObject({
      connected: true,
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })
    expect(status.tokenPreview).toBe('plat_s...cdef')
    expect(getPlatformAccessToken('local')).toBe('plat_superagent_token_1234567890abcdef')

    const settingsPath = path.join(tempDir, 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(onDisk.platformAuth).toBeDefined()
    expect(onDisk.platformAuth.token).toBe('plat_superagent_token_1234567890abcdef')
  })

  // Helpers for the org-switch / lifecycle tests below.
  function makePlatformSkillset(id: string, orgId: string): SkillsetConfig {
    return {
      id,
      url: 'http://platform-proxy.test/v1/skills/repo',
      name: id,
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform',
      providerData: { repoId: id, orgId },
    }
  }

  function makeGithubSkillset(id: string): SkillsetConfig {
    return {
      id,
      url: `https://github.com/example/${id}.git`,
      name: id,
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'github',
    }
  }

  function writeInstalledSkill(
    agentSlug: string,
    skillDirName: string,
    meta: InstalledSkillMetadata,
  ): void {
    const dir = path.join(getAgentsDir(), agentSlug, 'workspace', '.claude', 'skills', skillDirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# test skill', 'utf-8')
    fs.writeFileSync(path.join(dir, '.skillset-metadata.json'), JSON.stringify(meta, null, 2), 'utf-8')
  }

  function writeInstalledTemplate(
    agentSlug: string,
    meta: InstalledAgentMetadata,
  ): void {
    const dir = path.join(getAgentsDir(), agentSlug, 'workspace')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.skillset-agent-metadata.json'), JSON.stringify(meta, null, 2), 'utf-8')
  }

  it('switching orgs removes configs + installed files for the previous org', async () => {
    await savePlatformAuth('local', {
      token: 'plat_test_token_oldorg_xxxxxxxx',
      orgId: 'org_old',
    })

    // Seed: one platform skillset + one github skillset + installed skills for both.
    const settings = getSettings()
    settings.skillsets = [
      makePlatformSkillset('platform--old', 'org_old'),
      makeGithubSkillset('github--keep'),
    ]
    updateSettings(settings)

    writeInstalledSkill('agent-a', 'old-org-skill', {
      skillsetId: 'platform--old',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'old-org-skill',
      skillPath: 'skills/old-org-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_old', repoId: 'platform--old' },
    })
    writeInstalledSkill('agent-a', 'github-skill', {
      skillsetId: 'github--keep',
      skillsetUrl: 'https://github.com/example/github--keep.git',
      skillName: 'github-skill',
      skillPath: 'skills/github-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'github',
    })
    writeInstalledTemplate('agent-a', {
      skillsetId: 'platform--old',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      agentName: 'agent-a',
      agentPath: 'agents/agent-a/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_old', repoId: 'platform--old' },
    })

    // Switch to a new org.
    await savePlatformAuth('local', {
      token: 'plat_test_token_neworg_xxxxxxxx',
      orgId: 'org_new',
    })

    // Platform skillset for previous org is gone; github one is kept.
    const after = getSettings()
    expect(after.skillsets?.map((s) => s.id)).toEqual(['github--keep'])

    // Installed platform skill is gone; github skill is kept.
    const skillsDir = path.join(getAgentsDir(), 'agent-a', 'workspace', '.claude', 'skills')
    expect(fs.existsSync(path.join(skillsDir, 'old-org-skill'))).toBe(false)
    expect(fs.existsSync(path.join(skillsDir, 'github-skill'))).toBe(true)

    // Template metadata for the previous org is gone.
    const templateMeta = path.join(getAgentsDir(), 'agent-a', 'workspace', '.skillset-agent-metadata.json')
    expect(fs.existsSync(templateMeta)).toBe(false)
  })

  it('full disconnect removes all platform skillsets + installs', async () => {
    await savePlatformAuth('local', {
      token: 'plat_test_token_connected_xxx',
      orgId: 'org_x',
    })

    const settings = getSettings()
    settings.skillsets = [
      makePlatformSkillset('platform--x', 'org_x'),
      makeGithubSkillset('github--keep'),
    ]
    updateSettings(settings)

    writeInstalledSkill('agent-b', 'platform-skill', {
      skillsetId: 'platform--x',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'platform-skill',
      skillPath: 'skills/platform-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_x', repoId: 'platform--x' },
    })

    await revokePlatformToken({ clearLocal: true })

    const after = getSettings()
    expect(after.skillsets?.map((s) => s.id)).toEqual(['github--keep'])
    expect(fs.existsSync(
      path.join(getAgentsDir(), 'agent-b', 'workspace', '.claude', 'skills', 'platform-skill'),
    )).toBe(false)
  })

  it('lazy prune: reading a stale platform skill deletes the skill directory', async () => {
    // User is now logged into org_B but an install from org_A is still on disk.
    await savePlatformAuth('local', {
      token: 'plat_test_new_token_xxxxxxxxxxxx',
      orgId: 'org_B',
    })

    // Clear any settings cleanup side-effect so we can observe the lazy path
    // on the file-system level too.
    writeInstalledSkill('agent-c', 'stale-skill', {
      skillsetId: 'platform--prev',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'stale-skill',
      skillPath: 'skills/stale-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_A', repoId: 'platform--prev' },
    })

    // Lazy prune via the metadata reader.
    const { getInstalledSkillMetadata } = await import('./skillset-service')
    const result = await getInstalledSkillMetadata('agent-c', 'stale-skill')

    expect(result).toBeNull()
    const skillDir = path.join(
      getAgentsDir(), 'agent-c', 'workspace', '.claude', 'skills', 'stale-skill',
    )
    expect(fs.existsSync(skillDir)).toBe(false)
  })
})
