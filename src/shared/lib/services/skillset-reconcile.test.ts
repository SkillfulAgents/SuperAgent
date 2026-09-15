import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'

const state = vi.hoisted(() => ({
  slugs: [] as string[],
  files: new Map<string, unknown>(),
  // provider → whether an installed record is still valid; a thrown error
  // is the provider failing, which the reconcile treats as "keep".
  isInstalledValid: vi.fn((_provider: string | undefined, _meta: unknown): boolean => true),
  captureException: vi.fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: state.captureException,
}))

vi.mock('@shared/lib/config/settings', () => ({
  mutateSettings: vi.fn(),
}))

vi.mock('@shared/lib/skillset-provider', () => ({
  getSkillsetProvider: (provider?: string) => ({
    isConfigValid: () => true,
    isInstalledValid: (meta: unknown) => state.isInstalledValid(provider, meta),
  }),
}))

// Every agent the catalog lists gets an in-memory workspace.
vi.mock('@shared/lib/agent-actor', async () => {
  const workspacePath = await import('@shared/lib/agent-actor/workspace-path')
  const { InMemoryFileOps } = await import('@shared/lib/agent-actor/testing/in-memory-file-ops')
  const filesFor = (slug: string) => {
    let files = state.files.get(slug)
    if (!files) {
      files = new InMemoryFileOps()
      state.files.set(slug, files)
    }
    return files
  }
  return {
    ...workspacePath,
    agentCatalog: {
      list: async () => [...state.slugs],
      exists: async (slug: string) => state.slugs.includes(slug),
    },
    agentRegistry: {
      get: (slug: string) => ({ slug, files: filesFor(slug) }),
    },
  }
})

import { agentRegistry } from '@shared/lib/agent-actor'
import {
  pruneInstalledSkillIfInvalid,
  pruneInstalledTemplateIfInvalid,
  reconcileInstalledForCurrentAuth,
} from './skillset-reconcile'

function workspaceOf(slug: string): InMemoryFileOps {
  return agentRegistry.get(slug).files as InMemoryFileOps
}

async function seedSkill(slug: string, dir: string, meta: unknown, extra: Record<string, string> = {}): Promise<void> {
  const files = workspaceOf(slug)
  await files.putDoc(`.claude/skills/${dir}/SKILL.md`, '# skill')
  await files.putDoc(`.claude/skills/${dir}/.skillset-metadata.json`, typeof meta === 'string' ? meta : JSON.stringify(meta))
  for (const [name, content] of Object.entries(extra)) {
    await files.putDoc(`.claude/skills/${dir}/${name}`, content)
  }
}

const platformMeta = (orgId: string) => ({ provider: 'platform', providerData: { orgId } })

describe('skillset-reconcile', () => {
  beforeEach(() => {
    state.slugs = []
    state.files.clear()
    state.isInstalledValid.mockReset()
    state.isInstalledValid.mockReturnValue(true)
    state.captureException.mockReset()
  })

  describe('pruneInstalledSkillIfInvalid', () => {
    it('leaves a valid skill alone', async () => {
      await seedSkill('a', 'keep', platformMeta('org-1'), { 'notes.md': 'n' })
      const files = workspaceOf('a')

      expect(await pruneInstalledSkillIfInvalid(platformMeta('org-1'), files, '.claude/skills/keep')).toBe(false)
      expect(Object.keys(files.snapshot()).sort()).toEqual([
        '.claude/skills/keep/.skillset-metadata.json',
        '.claude/skills/keep/SKILL.md',
        '.claude/skills/keep/notes.md',
      ])
    })

    it('removes the whole skill directory when the provider says the record is invalid', async () => {
      state.isInstalledValid.mockReturnValue(false)
      await seedSkill('a', 'stale', platformMeta('old-org'), { 'sub/deep.txt': 'x' })
      await seedSkill('a', 'other', platformMeta('old-org'))
      const files = workspaceOf('a')

      expect(await pruneInstalledSkillIfInvalid(platformMeta('old-org'), files, '.claude/skills/stale')).toBe(true)
      expect(Object.keys(files.snapshot()).sort()).toEqual([
        '.claude/skills/other/.skillset-metadata.json',
        '.claude/skills/other/SKILL.md',
      ])
      expect(await files.stat('.claude/skills/stale')).toBeNull()
    })

    it('keeps the skill when the provider check throws (fail-open) and reports it', async () => {
      state.isInstalledValid.mockImplementation(() => {
        throw new Error('provider down')
      })
      await seedSkill('a', 'keep', platformMeta('org-1'))
      const files = workspaceOf('a')

      expect(await pruneInstalledSkillIfInvalid(platformMeta('org-1'), files, '.claude/skills/keep')).toBe(false)
      expect(await files.stat('.claude/skills/keep/SKILL.md')).not.toBeNull()
      expect(state.captureException).toHaveBeenCalledTimes(1)
    })

    it('reports a failed delete but still counts the record as pruned', async () => {
      state.isInstalledValid.mockReturnValue(false)
      const files = workspaceOf('a')
      const failing = { ...files, delete: vi.fn().mockRejectedValue(new Error('disk')) } as unknown as InMemoryFileOps

      expect(await pruneInstalledSkillIfInvalid(platformMeta('x'), failing, '.claude/skills/gone')).toBe(true)
      expect(state.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { area: 'skillset-reconcile', op: 'rm-skill' } }),
      )
    })
  })

  describe('pruneInstalledTemplateIfInvalid', () => {
    it('deletes only the metadata file, never the workspace around it', async () => {
      state.isInstalledValid.mockReturnValue(false)
      const files = workspaceOf('a')
      await files.putDoc('.skillset-agent-metadata.json', JSON.stringify(platformMeta('old-org')))
      await files.putDoc('CLAUDE.md', '# agent')
      await files.putDoc('notes/todo.md', '- x')

      expect(await pruneInstalledTemplateIfInvalid(platformMeta('old-org'), files, '.skillset-agent-metadata.json')).toBe(true)
      expect(Object.keys(files.snapshot()).sort()).toEqual(['CLAUDE.md', 'notes/todo.md'])
    })

    it('returns false and touches nothing for a valid record', async () => {
      const files = workspaceOf('a')
      await files.putDoc('.skillset-agent-metadata.json', JSON.stringify(platformMeta('org-1')))

      expect(await pruneInstalledTemplateIfInvalid(platformMeta('org-1'), files, '.skillset-agent-metadata.json')).toBe(false)
      expect(await files.getDoc('.skillset-agent-metadata.json')).not.toBeNull()
    })
  })

  describe('reconcileInstalledForCurrentAuth', () => {
    it('returns zeros when there are no agents', async () => {
      expect(await reconcileInstalledForCurrentAuth()).toEqual({ skillsRemoved: 0, templatesRemoved: 0 })
    })

    it('treats an agent with no skills directory and no template metadata as clean', async () => {
      state.slugs = ['fresh']
      await workspaceOf('fresh').putDoc('CLAUDE.md', '# agent')

      expect(await reconcileInstalledForCurrentAuth()).toEqual({ skillsRemoved: 0, templatesRemoved: 0 })
      expect(Object.keys(workspaceOf('fresh').snapshot())).toEqual(['CLAUDE.md'])
    })

    it('sweeps every listed agent, removing invalid skills and template metadata and counting them', async () => {
      state.slugs = ['a', 'b']
      // Like the real providers: github (the default) never invalidates;
      // platform compares the record's org with the connected one.
      state.isInstalledValid.mockImplementation((provider, meta) => {
        if (provider !== 'platform') return true
        const orgId = (meta as { providerData?: { orgId?: string } }).providerData?.orgId
        return orgId === 'current-org'
      })
      await seedSkill('a', 'stale-one', platformMeta('old-org'))
      await seedSkill('a', 'still-good', platformMeta('current-org'))
      await seedSkill('a', 'local-only', { skillName: 'local' })
      await workspaceOf('a').putDoc('.skillset-agent-metadata.json', JSON.stringify(platformMeta('old-org')))
      await seedSkill('b', 'stale-two', platformMeta('old-org'))
      await workspaceOf('b').putDoc('.skillset-agent-metadata.json', JSON.stringify(platformMeta('current-org')))

      expect(await reconcileInstalledForCurrentAuth()).toEqual({ skillsRemoved: 2, templatesRemoved: 1 })

      expect(Object.keys(workspaceOf('a').snapshot()).sort()).toEqual([
        '.claude/skills/local-only/.skillset-metadata.json',
        '.claude/skills/local-only/SKILL.md',
        '.claude/skills/still-good/.skillset-metadata.json',
        '.claude/skills/still-good/SKILL.md',
      ])
      expect(Object.keys(workspaceOf('b').snapshot()).sort()).toEqual(['.skillset-agent-metadata.json'])
    })

    it('skips skills whose metadata is unparsable, files in the skills directory, and skills without metadata', async () => {
      state.slugs = ['a']
      state.isInstalledValid.mockReturnValue(false)
      const files = workspaceOf('a')
      await seedSkill('a', 'broken', '{not json')
      await files.putDoc('.claude/skills/README.md', 'not a skill')
      await files.putDoc('.claude/skills/no-meta/SKILL.md', '# local')
      await files.putDoc('.skillset-agent-metadata.json', '{also broken')

      expect(await reconcileInstalledForCurrentAuth()).toEqual({ skillsRemoved: 0, templatesRemoved: 0 })
      expect(Object.keys(files.snapshot()).sort()).toEqual([
        '.claude/skills/README.md',
        '.claude/skills/broken/.skillset-metadata.json',
        '.claude/skills/broken/SKILL.md',
        '.claude/skills/no-meta/SKILL.md',
        '.skillset-agent-metadata.json',
      ])
      expect(state.isInstalledValid).not.toHaveBeenCalled()
    })
  })
})
