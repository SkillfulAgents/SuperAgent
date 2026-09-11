import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createLocalConfigOps } from './local-config-ops'
import { LocalFileOps } from './local-file-ops'
import { describeConfigOpsContract } from './testing/config-ops-contract'

async function harness() {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-config-ops-'))
  const root = path.join(parent, 'workspace')
  const files = new LocalFileOps(() => root)
  return {
    root,
    files,
    config: createLocalConfigOps({ files, workspaceHostPath: () => root }),
    dispose: () => fs.promises.rm(parent, { recursive: true, force: true }),
  }
}

describeConfigOpsContract('LocalConfigOps', harness)

describe('LocalConfigOps — what is local about it', () => {
  it('writes .env with the mode the container can read, and heals it on read', async () => {
    const h = await harness()
    try {
      await h.config.put('secrets', 'A=1\n')
      const envPath = path.join(h.root, '.env')
      expect((await fs.promises.stat(envPath)).mode & 0o777).toBe(0o666)

      await fs.promises.chmod(envPath, 0o600)
      expect(await h.config.get('secrets')).toBe('A=1\n')
      expect((await fs.promises.stat(envPath)).mode & 0o777).toBe(0o666)
    } finally {
      await h.dispose()
    }
  })

  it('never heals through a link the agent planted as .env', async () => {
    const h = await harness()
    try {
      await fs.promises.mkdir(h.root, { recursive: true })
      const target = path.join(path.dirname(h.root), 'not-the-agents.txt')
      await fs.promises.writeFile(target, 'host-only', { mode: 0o600 })
      await fs.promises.symlink(target, path.join(h.root, '.env'))

      // The read itself is refused (the link leaves the workspace)…
      await expect(h.config.get('secrets')).rejects.toThrow()
      // …and the mode of what the link points at is untouched.
      expect((await fs.promises.stat(target)).mode & 0o777).toBe(0o600)
    } finally {
      await h.dispose()
    }
  })

  it('serializes .env updates with the on-disk lock the container honours', async () => {
    const h = await harness()
    try {
      await h.config.put('secrets', '')
      let sawLock = false
      await h.config.update('secrets', async (current) => {
        sawLock = fs.existsSync(path.join(h.root, '.env.lock'))
        return `${current ?? ''}A=1\n`
      })
      expect(sawLock).toBe(true)
      expect(fs.existsSync(path.join(h.root, '.env.lock'))).toBe(false)
    } finally {
      await h.dispose()
    }
  })

  it('does not litter the workspace with lock files for documents only this process writes', async () => {
    const h = await harness()
    try {
      await h.config.update('preferences', () => ({}) as never)
      const entries = await fs.promises.readdir(h.root)
      expect(entries.filter((name) => name.endsWith('.lock'))).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})
