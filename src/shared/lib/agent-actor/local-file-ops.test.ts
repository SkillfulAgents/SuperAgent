import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalFileOps, createLocalFileOps } from './local-file-ops'
import { describeFileOpsContract } from './testing/file-ops-contract'
import { WorkspaceFileError } from './workspace-path'

async function tempRoot(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-file-ops-'))
}

// The contract, over a real directory. The workspace directory itself does
// not exist until the first write, like a freshly created agent's.
describeFileOpsContract('LocalFileOps', async () => {
  const parent = await tempRoot()
  const root = path.join(parent, 'workspace')
  return {
    files: new LocalFileOps(() => root),
    dispose: () => fs.promises.rm(parent, { recursive: true, force: true }),
  }
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error.code
    throw error
  }
  throw new Error('expected a WorkspaceFileError')
}

describe('LocalFileOps — links and host files', () => {
  let parent: string
  let root: string
  let outside: string
  let files: LocalFileOps

  beforeEach(async () => {
    parent = await tempRoot()
    root = path.join(parent, 'workspace')
    outside = path.join(parent, 'outside')
    await fs.promises.mkdir(root)
    await fs.promises.mkdir(outside)
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'secret')
    files = new LocalFileOps(() => root)
  })

  afterEach(async () => {
    await fs.promises.rm(parent, { recursive: true, force: true })
  })

  it('resolve reports where a link leads inside the workspace', async () => {
    await fs.promises.mkdir(path.join(root, 'real'))
    await fs.promises.writeFile(path.join(root, 'real', 'x.txt'), 'x')
    await fs.promises.symlink(path.join(root, 'real'), path.join(root, 'alias'))
    expect(await files.resolve('alias')).toBe('real')
    expect(await files.resolve('alias/x.txt')).toBe('real/x.txt')
    expect(await files.resolve('real/x.txt')).toBe('real/x.txt')
  })

  it('resolve refuses a link that leaves the workspace', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    await fs.promises.symlink(outside, path.join(root, 'leakdir'))
    expect(await codeOf(files.resolve('leak.txt'))).toBe('outside-workspace')
    expect(await codeOf(files.resolve('leakdir/secret.txt'))).toBe('outside-workspace')
  })

  it('resolve reads a dangling or looping link as absent', async () => {
    await fs.promises.symlink(path.join(root, 'nowhere'), path.join(root, 'dangling.txt'))
    await fs.promises.symlink('loop', path.join(root, 'loop'))
    expect(await files.resolve('dangling.txt')).toBeNull()
    expect(await files.resolve('loop')).toBeNull()
    expect(await files.stat('dangling.txt')).toBeNull()
    expect(await files.stat('loop')).toBeNull()
    expect(await files.getDoc('loop')).toBeNull()
  })

  it('links are not listed', async () => {
    await fs.promises.writeFile(path.join(root, 'real.txt'), 'r')
    await fs.promises.symlink(path.join(root, 'real.txt'), path.join(root, 'alias.txt'))
    expect((await files.list('')).map((entry) => entry.name)).toEqual(['real.txt'])
  })

  it('delete removes the link, not what it points at', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    await files.delete('leak.txt')
    expect(fs.existsSync(path.join(root, 'leak.txt'))).toBe(false)
    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
  })

  it('putDoc keeps the mode of the file it replaces', async () => {
    await fs.promises.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await files.putDoc('run.sh', '#!/bin/sh\necho hi\n')
    expect((await fs.promises.stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect(await fs.promises.readFile(path.join(root, 'run.sh'), 'utf-8')).toBe('#!/bin/sh\necho hi\n')
  })

  it('write leaves the previous file intact when the source fails', async () => {
    await fs.promises.writeFile(path.join(root, 'data.bin'), 'old')
    // The source fails after its first chunk was consumed, the way a dropped
    // upload does; erroring before a reader attaches would surface as an
    // unhandled error outside the test.
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
      },
      pull(controller) {
        controller.error(new Error('source broke'))
      },
    })
    await expect(files.write('data.bin', failing)).rejects.toThrow('source broke')
    expect(await fs.promises.readFile(path.join(root, 'data.bin'), 'utf-8')).toBe('old')
    expect((await fs.promises.readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('write cancels the source when the destination is refused', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    expect(['invalid-path', 'outside-workspace']).toContain(await codeOf(files.write('../outside/new.txt', body)))
    expect(cancelled).toBe(true)
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
  })

  it('write cancels the source when the destination cannot be opened', async () => {
    // A read-only directory: the destination passes containment, then the
    // temp file cannot be created. The source is a file on this machine, the
    // way an upload assembled in the temp dir is; it must not stay open.
    await fs.promises.mkdir(path.join(root, 'sealed'), { mode: 0o500 })
    await fs.promises.writeFile(path.join(outside, 'upload.bin'), 'payload')
    const source = fs.createReadStream(path.join(outside, 'upload.bin'))
    try {
      expect(await codeOf(files.write('sealed/upload.bin', Readable.toWeb(source) as ReadableStream<Uint8Array>))).toBe('not-accessible')
      await new Promise((resolve) => setImmediate(resolve))
      expect(source.destroyed).toBe(true)
    } finally {
      await fs.promises.chmod(path.join(root, 'sealed'), 0o700)
    }
  })

  it('creates a write\'s parent directories only when the write finds them missing', async () => {
    const mkdir = vi.spyOn(fs.promises, 'mkdir')
    try {
      await files.putDoc('top.txt', 'in the root')
      expect(mkdir).not.toHaveBeenCalled()

      await files.putDoc('deep/er/doc.txt', 'nested')
      expect(mkdir).toHaveBeenCalledTimes(1)
      expect(await fs.promises.readFile(path.join(root, 'deep', 'er', 'doc.txt'), 'utf-8')).toBe('nested')

      mkdir.mockClear()
      await files.write('deep/er/blob.bin', new Uint8Array([1]))
      await files.moveHostFile(path.join(outside, 'secret.txt'), 'deep/er/moved.txt')
      expect(mkdir).not.toHaveBeenCalled()
    } finally {
      mkdir.mockRestore()
    }
  })

  it('stat reports the permission bits', async () => {
    await fs.promises.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.promises.writeFile(path.join(root, 'notes.txt'), 'n', { mode: 0o644 })
    expect((await files.stat('run.sh'))?.mode).toBe(0o755)
    expect((await files.stat('notes.txt'))?.mode).toBe(0o644)
  })

  it('getDoc hands back the bytes it read, not a copy', async () => {
    await fs.promises.writeFile(path.join(root, 'doc.bin'), Buffer.from([1, 2, 3]))
    const bytes = await files.getDoc('doc.bin')
    expect(Buffer.isBuffer(bytes)).toBe(true)
  })

  it('copyHostFile keeps the mode of the file it copies', async () => {
    await fs.promises.writeFile(path.join(outside, 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await files.mkdir('bin')
    await files.copyHostFile(path.join(outside, 'tool.sh'), 'bin/tool.sh')
    expect((await fs.promises.stat(path.join(root, 'bin', 'tool.sh'))).mode & 0o777).toBe(0o755)
    expect(await fs.promises.readFile(path.join(outside, 'tool.sh'), 'utf-8')).toBe('#!/bin/sh\n')
  })

  it('moveHostFile renames the file into the workspace and reports its size', async () => {
    await fs.promises.writeFile(path.join(outside, 'assembled'), 'twelve bytes')
    const { ino } = await fs.promises.stat(path.join(outside, 'assembled'))

    expect(await files.moveHostFile(path.join(outside, 'assembled'), 'uploads/report.pdf')).toEqual({ size: 12 })

    expect(fs.existsSync(path.join(outside, 'assembled'))).toBe(false)
    const moved = await fs.promises.stat(path.join(root, 'uploads', 'report.pdf'))
    expect(moved.ino).toBe(ino) // the same file, not a copy of it
    expect(await fs.promises.readFile(path.join(root, 'uploads', 'report.pdf'), 'utf-8')).toBe('twelve bytes')
  })

  it('moveHostFile never lands outside the workspace', async () => {
    await fs.promises.writeFile(path.join(outside, 'assembled'), 'x')
    expect(['invalid-path', 'outside-workspace']).toContain(await codeOf(files.moveHostFile(path.join(outside, 'assembled'), '../outside/report.pdf')))
    expect(fs.existsSync(path.join(outside, 'assembled'))).toBe(true)
    expect(fs.existsSync(path.join(outside, 'report.pdf'))).toBe(false)
  })

  it('write rejects, without an unhandled error, when the source fails before the destination is open', async () => {
    // The zip reader fails an entry's stream the moment it inflates past its
    // declared size, which can be before the writer has opened its temp file.
    // A stream failing with nobody listening takes the whole process down.
    const uncaught: unknown[] = []
    const record = (error: unknown) => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('entry inflated past its declared size'))
        },
      })
      await expect(files.write('imported.bin', failing)).rejects.toThrow('entry inflated past its declared size')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(uncaught).toEqual([])
      expect(await files.stat('imported.bin')).toBeNull()
      expect((await fs.promises.readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  })

  it('copyHostFile replaces a link at the destination instead of writing through it', async () => {
    // The agent can plant a link in uploads/ from inside the container; the
    // next folder upload with that entry name must not follow it.
    await files.mkdir('uploads')
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'uploads', 'exist.txt'))
    await fs.promises.writeFile(path.join(outside, 'exist.txt'), 'uploaded')

    await files.copyHostFile(path.join(outside, 'exist.txt'), 'uploads/exist.txt')

    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
    expect((await fs.promises.lstat(path.join(root, 'uploads', 'exist.txt'))).isSymbolicLink()).toBe(false)
    expect(await fs.promises.readFile(path.join(root, 'uploads', 'exist.txt'), 'utf-8')).toBe('uploaded')
  })

  it('copyHostFile replaces a dangling link and overwrites an existing file', async () => {
    await files.mkdir('uploads')
    await fs.promises.symlink(path.join(outside, 'nowhere.txt'), path.join(root, 'uploads', 'dangling.txt'))
    await fs.promises.writeFile(path.join(root, 'uploads', 'old.txt'), 'old')
    await fs.promises.writeFile(path.join(outside, 'new.txt'), 'new')

    await files.copyHostFile(path.join(outside, 'new.txt'), 'uploads/dangling.txt')
    await files.copyHostFile(path.join(outside, 'new.txt'), 'uploads/old.txt')

    expect(fs.existsSync(path.join(outside, 'nowhere.txt'))).toBe(false)
    expect((await fs.promises.lstat(path.join(root, 'uploads', 'dangling.txt'))).isSymbolicLink()).toBe(false)
    expect(await fs.promises.readFile(path.join(root, 'uploads', 'dangling.txt'), 'utf-8')).toBe('new')
    expect(await fs.promises.readFile(path.join(root, 'uploads', 'old.txt'), 'utf-8')).toBe('new')
  })

  it('moveHostFile replaces a link at the destination when the move has to copy', async () => {
    await files.mkdir('uploads')
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'uploads', 'report.pdf'))
    await fs.promises.writeFile(path.join(outside, 'assembled'), 'moved')
    // The temp dir and the workspace on different devices: the rename is
    // refused and the move falls back to a copy.
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))
    try {
      expect(await files.moveHostFile(path.join(outside, 'assembled'), 'uploads/report.pdf')).toEqual({ size: 5 })
    } finally {
      rename.mockRestore()
    }

    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
    expect((await fs.promises.lstat(path.join(root, 'uploads', 'report.pdf'))).isSymbolicLink()).toBe(false)
    expect(await fs.promises.readFile(path.join(root, 'uploads', 'report.pdf'), 'utf-8')).toBe('moved')
    expect(fs.existsSync(path.join(outside, 'assembled'))).toBe(false)
  })
})

describe('createLocalFileOps', () => {
  it('reads the workspace directory for the slug at call time', async () => {
    const parent = await tempRoot()
    try {
      let generation = 'first'
      const files = createLocalFileOps('agent-a', {
        getAgentWorkspaceDir: (slug) => path.join(parent, generation, slug),
      })
      await files.putDoc('note.txt', 'one')
      expect(fs.existsSync(path.join(parent, 'first', 'agent-a', 'note.txt'))).toBe(true)

      generation = 'second'
      await files.putDoc('note.txt', 'two')
      expect(fs.existsSync(path.join(parent, 'second', 'agent-a', 'note.txt'))).toBe(true)
    } finally {
      await fs.promises.rm(parent, { recursive: true, force: true })
    }
  })
})
