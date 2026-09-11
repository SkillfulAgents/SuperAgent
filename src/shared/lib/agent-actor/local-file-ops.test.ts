import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('LocalFileOps — symbolic links', () => {
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

  it('a link that leaves the workspace is an escape for every read', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    await fs.promises.symlink(outside, path.join(root, 'leakdir'))

    expect(await codeOf(files.stat('leak.txt'))).toBe('outside-workspace')
    expect(await codeOf(files.getDoc('leak.txt'))).toBe('outside-workspace')
    expect(await codeOf(files.read('leak.txt'))).toBe('outside-workspace')
    expect(await codeOf(files.list('leakdir'))).toBe('outside-workspace')
    expect(await codeOf(files.getDoc('leakdir/secret.txt'))).toBe('outside-workspace')
  })

  it('writes never go through a link', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    await fs.promises.symlink(outside, path.join(root, 'leakdir'))
    await fs.promises.symlink(path.join(outside, 'dangling-target'), path.join(root, 'dangling.txt'))

    expect(await codeOf(files.putDoc('leak.txt', 'overwritten'))).toBe('outside-workspace')
    expect(await codeOf(files.write('leakdir/new.txt', new Uint8Array([1])))).toBe('outside-workspace')
    expect(await codeOf(files.mkdir('leakdir/sub'))).toBe('outside-workspace')
    expect(await codeOf(files.putDoc('dangling.txt', 'created'))).toBe('outside-workspace')

    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'dangling-target'))).toBe(false)
  })

  it('a dangling link reads as absent', async () => {
    await fs.promises.symlink(path.join(root, 'nowhere'), path.join(root, 'dangling.txt'))
    expect(await files.stat('dangling.txt')).toBeNull()
    expect(await files.getDoc('dangling.txt')).toBeNull()
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

  it('delete never reaches through a linked ancestor, even to remove a link', async () => {
    await fs.promises.symlink(outside, path.join(root, 'escape'))
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(outside, 'important-link'))

    expect(await codeOf(files.delete('escape/important-link'))).toBe('outside-workspace')
    expect(await codeOf(files.delete('escape/secret.txt'))).toBe('outside-workspace')
    expect(fs.existsSync(path.join(outside, 'important-link'))).toBe(true)
    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')

    // The escaping link itself sits inside the workspace: deleting it removes
    // the link and nothing behind it.
    await files.delete('escape', { recursive: true })
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'important-link'))).toBe(true)
    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
  })

  it('a link that stays inside the workspace is followed', async () => {
    await fs.promises.mkdir(path.join(root, 'real'))
    await fs.promises.writeFile(path.join(root, 'real', 'x.txt'), 'x')
    await fs.promises.symlink(path.join(root, 'real'), path.join(root, 'alias'))
    expect(new TextDecoder().decode((await files.getDoc('alias/x.txt')) ?? new Uint8Array())).toBe('x')
    expect((await files.list('alias')).map((entry) => entry.name)).toEqual(['x.txt'])
    // …but a caller scoping access to a sub-tree can tell where it really went.
    expect((await files.stat('alias'))?.resolvedPath).toBe('real')
    expect((await files.stat('alias/x.txt'))?.resolvedPath).toBe('real/x.txt')
    expect((await files.stat('real/x.txt'))?.resolvedPath).toBe('real/x.txt')
  })

  it('a link that loops reads as absent, not as a failure', async () => {
    await fs.promises.symlink('loop', path.join(root, 'loop'))
    expect(await files.stat('loop')).toBeNull()
    expect(await files.getDoc('loop')).toBeNull()
    expect(await codeOf(files.list('loop'))).toBe('not-found')
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
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    expect(await codeOf(files.write('leak.txt', body))).toBe('outside-workspace')
    expect(cancelled).toBe(true)
    expect(await fs.promises.readFile(path.join(outside, 'secret.txt'), 'utf-8')).toBe('secret')
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
    await fs.promises.symlink(outside, path.join(root, 'leakdir'))
    await fs.promises.writeFile(path.join(outside, 'assembled'), 'x')
    expect(await codeOf(files.moveHostFile(path.join(outside, 'assembled'), 'leakdir/report.pdf'))).toBe('outside-workspace')
    expect(fs.existsSync(path.join(outside, 'assembled'))).toBe(true)
    expect(fs.existsSync(path.join(outside, 'report.pdf'))).toBe(false)
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
