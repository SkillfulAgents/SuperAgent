import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyHostDirIntoWorkspace } from './copy-into-workspace'
import { LocalFileOps } from './local-file-ops'
import { InMemoryFileOps } from './testing/in-memory-file-ops'

describe('copyHostDirIntoWorkspace', () => {
  let parent: string
  let source: string

  beforeEach(async () => {
    parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copy-into-workspace-'))
    source = path.join(parent, 'source')
    await fs.promises.mkdir(path.join(source, 'scripts'), { recursive: true })
    await fs.promises.mkdir(path.join(source, '.git'))
    await fs.promises.writeFile(path.join(source, 'SKILL.md'), '# skill\n')
    await fs.promises.writeFile(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    await fs.promises.writeFile(path.join(source, '.git', 'HEAD'), 'ref\n')
  })

  afterEach(async () => {
    await fs.promises.rm(parent, { recursive: true, force: true })
  })

  it('keeps the executable bit on a script copied into a workspace on this machine', async () => {
    const root = path.join(parent, 'workspace')
    const files = new LocalFileOps(() => root)

    await copyHostDirIntoWorkspace(files, source, '.claude/skills/demo')

    const copied = path.join(root, '.claude', 'skills', 'demo', 'scripts', 'run.sh')
    expect((await fs.promises.stat(copied)).mode & 0o777).toBe(0o755)
    expect(await fs.promises.readFile(copied, 'utf-8')).toBe('#!/bin/sh\necho hi\n')
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'demo', '.git'))).toBe(false)
  })

  it('hands the source mode to a workspace that is not a directory on this machine', async () => {
    const files = new InMemoryFileOps()
    const write = vi.spyOn(files, 'write')

    await copyHostDirIntoWorkspace(files, source, 'skills/demo')

    expect(Object.keys(files.snapshot()).sort()).toEqual(['skills/demo/SKILL.md', 'skills/demo/scripts/run.sh'])
    const script = write.mock.calls.find(([dest]) => dest === 'skills/demo/scripts/run.sh')
    expect(script?.[2]).toEqual({ mode: 0o755 })
  })

  it('copies a directory reached through a link once, and does not loop on a link back into the tree', async () => {
    await fs.promises.symlink('.', path.join(source, 'loop'))
    await fs.promises.symlink(path.join(source, 'scripts'), path.join(source, 'scripts-again'))
    const files = new InMemoryFileOps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await copyHostDirIntoWorkspace(files, source, 'demo', { followSymlinks: true })
    } finally {
      warn.mockRestore()
    }

    expect(Object.keys(files.snapshot()).sort()).toEqual(['demo/SKILL.md', 'demo/scripts/run.sh'])
  })

  it('skips links when not asked to follow them', async () => {
    await fs.promises.symlink(path.join(source, 'scripts'), path.join(source, 'scripts-again'))
    const files = new InMemoryFileOps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await copyHostDirIntoWorkspace(files, source, 'demo')
    } finally {
      warn.mockRestore()
    }

    expect(Object.keys(files.snapshot()).sort()).toEqual(['demo/SKILL.md', 'demo/scripts/run.sh'])
  })
})
