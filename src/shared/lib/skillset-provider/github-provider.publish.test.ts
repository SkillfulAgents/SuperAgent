import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({ skillsets: [], skillsetCredentials: {} }) }))
vi.mock('child_process', () => ({
  execFile: vi.fn((_command: string, args: string[], _options: unknown, callback: (error: null, result: { stdout: string; stderr: string }) => void) => {
    const stdout = args[0] === 'repo' && args[1] === 'view' ? 'example/templates'
      : args[0] === 'api' ? 'test-user' : args[0] === 'symbolic-ref' ? 'refs/remotes/origin/main'
        : args[0] === 'pr' ? 'https://github.com/example/templates/pull/1' : ''
    callback(null, { stdout, stderr: '' })
  }),
}))

import { GithubSkillsetProvider } from './github-provider'

describe('GitHub agent instruction filename migration', () => {
  let repoDir: string
  beforeEach(async () => {
    repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-publish-'))
    await fs.promises.mkdir(path.join(repoDir, 'agents/agent'), { recursive: true })
    await fs.promises.writeFile(path.join(repoDir, 'agents/agent/CLAUDE.md'), '# Stale upstream instructions')
  })
  afterEach(async () => { await fs.promises.rm(repoDir, { recursive: true, force: true }) })

  it.each([false, true])('publishes canonical instructions and preserves legacy only when explicitly submitted: %s', async (both) => {
    const files = [{ path: 'agents/agent/AGENTS.md', content: '# Canonical' }]
    if (both) files.push({ path: 'agents/agent/CLAUDE.md', content: '# Independent legacy' })
    await new GithubSkillsetProvider().publishUpdate({
      repoDir, files, deletePaths: both ? [] : ['agents/agent/CLAUDE.md'], branchPrefix: 'test', title: 'Update agent', body: 'Update instructions',
      skillsetId: 'test', skillsetUrl: 'https://github.com/example/templates',
      targetName: 'agent', targetType: 'agent', message: 'Update instructions',
    })
    expect(await fs.promises.readFile(path.join(repoDir, 'agents/agent/AGENTS.md'), 'utf8')).toBe('# Canonical')
    if (both) expect(await fs.promises.readFile(path.join(repoDir, 'agents/agent/CLAUDE.md'), 'utf8')).toBe('# Independent legacy')
    else expect(fs.existsSync(path.join(repoDir, 'agents/agent/CLAUDE.md'))).toBe(false)
  })
})
