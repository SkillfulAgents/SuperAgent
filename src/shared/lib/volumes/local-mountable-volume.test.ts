import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { LocalMountableVolume } from './local-mountable-volume'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error.code
    throw error
  }
  throw new Error('expected a WorkspaceFileError')
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

// Holds a move inside the gate: its rename to `to` waits until released.
function holdRename(to: string): { release: () => void; restore: () => void } {
  const rename = fs.promises.rename
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, dest) => {
    if (String(dest) === to) await held
    return rename(from, dest)
  })
  return { release, restore: () => spy.mockRestore() }
}

function stalledBody(): { body: ReadableStream<Uint8Array>; finish: () => void } {
  let finish: () => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'))
      finish = () => controller.close()
    },
  })
  return { body, finish: () => finish() }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('LocalMountableVolume', () => {
  let parent: string
  let folder: string
  let outside: string
  let volume: LocalMountableVolume

  beforeEach(async () => {
    parent = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'client-folder-ops-')))
    folder = path.join(parent, 'folder')
    outside = path.join(parent, 'outside')
    await fs.promises.mkdir(folder)
    await fs.promises.mkdir(outside)
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'secret')
    volume = new LocalMountableVolume('volume', 'folder', { path: folder })
  })

  afterEach(async () => {
    await fs.promises.rm(parent, { recursive: true, force: true })
  })

  it('refuses a link that leads out of the folder, and lists it as an empty file', async () => {
    await fs.promises.symlink(outside, path.join(folder, 'escape'))
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    expect(await codeOf(volume.read('escape/secret.txt'))).toBe('outside-workspace')
    expect(await codeOf(volume.read('escape'))).toBe('not-accessible')
    const listed = (await volume.list('')).map(({ name, kind, size }) => ({ name, kind, size }))
    expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'a.txt', kind: 'file', size: 1 },
      { name: 'escape', kind: 'file', size: 0 },
    ])
  })

  it('deletes a link that leads out of the folder, and leaves what it points at', async () => {
    await fs.promises.symlink(outside, path.join(folder, 'escape'))
    await volume.delete('escape')
    expect(fs.existsSync(path.join(folder, 'escape'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('lists every link, a dangling one included, as an empty file it cannot read', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    await fs.promises.symlink(path.join(folder, 'a.txt'), path.join(folder, 'inner'))
    await fs.promises.symlink(path.join(folder, 'gone.txt'), path.join(folder, 'dangling'))
    const listed = (await volume.list('')).map(({ name, kind, size }) => ({ name, kind, size }))
    expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'a.txt', kind: 'file', size: 1 },
      { name: 'dangling', kind: 'file', size: 0 },
      { name: 'inner', kind: 'file', size: 0 },
    ])
    expect(await volume.stat('inner')).toMatchObject({ kind: 'file', size: 0 })
    expect(await codeOf(volume.read('inner'))).toBe('not-accessible')
  })

  // A recursive delete walks what the listing shows: a linked folder must not be entered.
  it('lists a link to a folder as a file, so removing it never reaches the folder', async () => {
    await fs.promises.mkdir(path.join(folder, 'packages', 'pkg'), { recursive: true })
    await fs.promises.writeFile(path.join(folder, 'packages', 'pkg', 'index.js'), 'source')
    await fs.promises.mkdir(path.join(folder, 'node_modules'))
    await fs.promises.symlink(path.join(folder, 'packages', 'pkg'), path.join(folder, 'node_modules', 'pkg'))
    expect(await volume.list('node_modules')).toMatchObject([{ name: 'pkg', kind: 'file' }])
    await volume.delete('node_modules/pkg')
    await volume.delete('node_modules')
    expect(fs.readFileSync(path.join(folder, 'packages', 'pkg', 'index.js'), 'utf8')).toBe('source')
  })

  it('leaves out a name with a backslash, which no request can name', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    await fs.promises.writeFile(path.join(folder, 'a\\b'), 'x')
    expect((await volume.list('')).map((entry) => entry.name)).toEqual(['a.txt'])
  })

  it('moves a link as a link', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    await fs.promises.symlink(outside, path.join(folder, 'escape'))
    await volume.move('escape', 'moved')
    expect(fs.lstatSync(path.join(folder, 'moved')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('replaces a link with the written file, wherever it led, and never writes through it', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    await fs.promises.symlink(path.join(folder, 'a.txt'), path.join(folder, 'inner'))
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'escape'))
    await fs.promises.symlink(path.join(outside, 'gone.txt'), path.join(folder, 'dangling'))
    await fs.promises.symlink(path.join(folder, 'loop'), path.join(folder, 'loop'))
    await fs.promises.chmod(path.join(outside, 'secret.txt'), 0o444)
    for (const name of ['inner', 'escape', 'dangling', 'loop']) await volume.write(name, new Blob([name]).stream())
    for (const name of ['inner', 'escape', 'dangling', 'loop']) {
      expect(fs.lstatSync(path.join(folder, name)).isFile()).toBe(true)
      expect(fs.readFileSync(path.join(folder, name), 'utf8')).toBe(name)
    }
    // The new file takes no mode from the link's target.
    expect(fs.statSync(path.join(folder, 'escape')).mode & 0o222).not.toBe(0)
    expect(fs.existsSync(path.join(outside, 'gone.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('a')
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('keeps a link while a write onto it uploads, and after the upload fails', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'escape'))
    let pulls = 0
    let linkDuringUpload = false
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) return controller.enqueue(new TextEncoder().encode('partial'))
        linkDuringUpload = fs.lstatSync(path.join(folder, 'escape')).isSymbolicLink()
        controller.error(new Error('upload dropped'))
      },
    })
    await expect(volume.write('escape', failing)).rejects.toThrow()
    expect(pulls).toBeGreaterThan(1)
    expect(linkDuringUpload).toBe(true)
    expect(fs.lstatSync(path.join(folder, 'escape')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('refuses a write under a dangling link as a missing parent', async () => {
    await fs.promises.symlink(path.join(outside, 'gone'), path.join(folder, 'dangling'))
    expect(await codeOf(volume.write('dangling/x.txt', new Blob(['x']).stream()))).toBe('not-found')
    expect(fs.existsSync(path.join(outside, 'gone'))).toBe(false)
  })

  it('finds nothing once the folder is gone, and never makes it again', async () => {
    await fs.promises.rm(folder, { recursive: true })
    expect(await codeOf(volume.stat(''))).toBe('not-found')
    expect(await codeOf(volume.list(''))).toBe('not-found')
    expect(await codeOf(volume.read('a.txt'))).toBe('not-found')
    expect(await codeOf(volume.write('a.txt', new Blob(['x']).stream()))).toBe('not-found')
    expect(await codeOf(volume.mkdir('d'))).toBe('not-found')
    expect(fs.existsSync(folder)).toBe(false)
  })

  it('deletes an empty folder but not a full one', async () => {
    await fs.promises.mkdir(path.join(folder, 'full'))
    await fs.promises.writeFile(path.join(folder, 'full', 'a.txt'), 'a')
    await fs.promises.mkdir(path.join(folder, 'empty'))
    expect(await codeOf(volume.delete('full'))).toBe('not-empty')
    await volume.delete('empty')
    expect(fs.existsSync(path.join(folder, 'empty'))).toBe(false)
  })

  it('deletes a link, not what it points at', async () => {
    await fs.promises.writeFile(path.join(folder, 'target.txt'), 't')
    await fs.promises.symlink(path.join(folder, 'target.txt'), path.join(folder, 'link'))
    await volume.delete('link')
    expect(fs.existsSync(path.join(folder, 'target.txt'))).toBe(true)
  })

  it('refuses a move into a missing folder, into itself, or a file onto a folder', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    expect(await codeOf(volume.move('a.txt', 'no/a.txt'))).toBe('not-a-directory')
    await fs.promises.writeFile(path.join(folder, 'file'), 'f')
    expect(await codeOf(volume.move('a.txt', 'file/a.txt'))).toBe('not-a-directory')
    expect(await codeOf(volume.move('gone.txt', 'b.txt'))).toBe('not-found')
    await fs.promises.mkdir(path.join(folder, 'd'))
    expect(await codeOf(volume.move('d', 'd/inside'))).toBe('invalid-path')
    expect(await codeOf(volume.move('a.txt', 'd'))).toBe('already-exists')
    expect(await codeOf(volume.move('d', 'file'))).toBe('already-exists')
    expect(await codeOf(volume.move('file/x', 'y'))).toBe('not-found')
    expect(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8')).toBe('a')
  })

  it('never passes through a link, even one that leads inside the folder', async () => {
    await fs.promises.mkdir(path.join(folder, 'real'))
    await fs.promises.writeFile(path.join(folder, 'real', 'a.txt'), 'a')
    await fs.promises.symlink(path.join(folder, 'real'), path.join(folder, 'alias'))
    expect(await codeOf(volume.read('alias/a.txt'))).toBe('not-accessible')
    expect(await codeOf(volume.delete('alias/a.txt'))).toBe('not-accessible')
    expect(await codeOf(volume.write('alias/b.txt', new Blob(['x']).stream()))).toBe('not-accessible')
    expect(fs.readdirSync(path.join(folder, 'real'))).toEqual(['a.txt'])
  })

  it('treats a folder replaced by a file as gone', async () => {
    await fs.promises.rm(folder, { recursive: true })
    await fs.promises.writeFile(folder, 'not a folder')
    expect(await codeOf(volume.stat(''))).toBe('not-found')
    expect(await codeOf(volume.mkdir(''))).toBe('not-found')
    expect(await codeOf(volume.delete(''))).toBe('not-found')
    expect(await codeOf(volume.move('', 'x'))).toBe('not-found')
    expect(await codeOf(volume.write('', new Blob(['x']).stream()))).toBe('not-found')
  })

  it('treats a folder replaced by a link as gone', async () => {
    await fs.promises.rename(folder, path.join(parent, 'moved'))
    await fs.promises.symlink(outside, folder)
    expect(await codeOf(volume.stat(''))).toBe('not-found')
    expect(await codeOf(volume.list(''))).toBe('not-found')
  })

  it('never makes, replaces, removes or moves the root', async () => {
    expect(await codeOf(volume.mkdir(''))).toBe('invalid-path')
    expect(await codeOf(volume.write('', new Blob(['x']).stream()))).toBe('invalid-path')
    expect(await codeOf(volume.delete(''))).toBe('invalid-path')
    expect(await codeOf(volume.move('', 'x'))).toBe('invalid-path')
    expect(fs.statSync(folder).isDirectory()).toBe(true)
  })

  // A move is the only operation that can put a link where a checked folder was.
  it('never makes again a folder deleted between an upload\'s check and its write', async () => {
    await fs.promises.mkdir(path.join(folder, 'd'))
    const write = LocalFileOps.prototype.write
    const spy = vi.spyOn(LocalFileOps.prototype, 'write').mockImplementation(async function (this: LocalFileOps, ...args) {
      await fs.promises.rmdir(path.join(folder, 'd'))
      return write.apply(this, args)
    })
    try {
      expect(await codeOf(volume.write('d/x.txt', new Blob(['x']).stream()))).toBe('not-found')
      expect(fs.existsSync(path.join(folder, 'd'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('holds every later operation in the volume while a move lands', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const hold = holdRename(path.join(folder, 'c.txt'))
    try {
      const order: string[] = []
      const moving = volume.move('a.txt', 'c.txt').then(() => { order.push('move') })
      await tick(20)
      const listing = volume.list('').then((entries) => { order.push('list'); return entries.map((e) => e.name) })
      await tick(50)
      expect(order).toEqual([])
      hold.release()
      await moving
      expect(await listing).toEqual(['c.txt'])
      expect(order).toEqual(['move', 'list'])
    } finally {
      hold.restore()
    }
  })

  it('answers a stat of the root while a move lands, in its own volume or an enclosing one', async () => {
    await fs.promises.mkdir(path.join(folder, 'sub'))
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const inner = new LocalMountableVolume('inner', 'sub', { path: path.join(folder, 'sub') })
    const hold = holdRename(path.join(folder, 'c.txt'))
    try {
      const moving = volume.move('a.txt', 'c.txt')
      await tick(20)
      expect((await volume.stat('')).kind).toBe('directory')
      expect((await inner.stat('')).kind).toBe('directory')
      hold.release()
      await moving
    } finally {
      hold.restore()
    }
  })

  it("holds a nested volume's later operations while a move in the enclosing volume lands", async () => {
    await fs.promises.mkdir(path.join(folder, 'sub'))
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const inner = new LocalMountableVolume('inner', 'sub', { path: path.join(folder, 'sub') })
    const hold = holdRename(path.join(folder, 'c.txt'))
    try {
      const order: string[] = []
      const moving = volume.move('a.txt', 'c.txt').then(() => { order.push('move') })
      await tick(20)
      const listing = inner.list('').then(() => { order.push('list') })
      await tick(50)
      expect(order).toEqual([])
      hold.release()
      await moving
      await listing
      expect(order).toEqual(['move', 'list'])
    } finally {
      hold.restore()
    }
  })

  it('lets a move and a read through while an upload streams, and publishes the upload after', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const { body, finish } = stalledBody()
    const writing = volume.write('b.txt', body)
    await tick(20)
    await volume.move('a.txt', 'c.txt')
    expect((await volume.list('')).map((e) => e.name)).toContain('c.txt')
    expect(fs.existsSync(path.join(folder, 'b.txt'))).toBe(false)
    finish()
    await writing
    expect(fs.readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('x')
  })

  it('publishes an upload that finishes while a move lands only once the move is done', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const { body, finish } = stalledBody()
    const writing = volume.write('b.txt', body)
    await tick(20)
    const hold = holdRename(path.join(folder, 'c.txt'))
    try {
      const moving = volume.move('a.txt', 'c.txt')
      await tick(20)
      finish()
      await tick(50)
      expect(fs.existsSync(path.join(folder, 'b.txt'))).toBe(false)
      hold.release()
      await moving
      await writing
      expect(fs.readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('x')
    } finally {
      hold.restore()
    }
  })

  it('runs a move only once an operation already running in the volume finishes', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    const readdir = fs.promises.readdir
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args: Parameters<typeof readdir>) => {
      await held
      return readdir(...args)
    })
    try {
      const listing = volume.list('').then((entries) => entries.map((e) => e.name))
      await tick(20)
      const moving = volume.move('a.txt', 'c.txt')
      await tick(50)
      expect(fs.existsSync(path.join(folder, 'a.txt'))).toBe(true)
      release()
      expect(await listing).toEqual(['a.txt'])
      await moving
      expect(fs.existsSync(path.join(folder, 'c.txt'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('publishes an upload only once an operation already running in the volume finishes', async () => {
    const readdir = fs.promises.readdir
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args: Parameters<typeof readdir>) => {
      await held
      return readdir(...args)
    })
    try {
      const listing = volume.list('')
      await tick(20)
      const writing = volume.write('b.txt', new Blob(['x']).stream())
      await tick(50)
      expect(fs.existsSync(path.join(folder, 'b.txt'))).toBe(false)
      release()
      await listing
      await writing
      expect(fs.readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('x')
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses to publish an upload whose staged file was swapped for a link, and keeps the old file', async () => {
    await fs.promises.writeFile(path.join(folder, 'b.txt'), 'old')
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(folder, 'evil'))
    const { body, finish } = stalledBody()
    const writing = volume.write('b.txt', body)
    await tick(20)
    const staged = fs.readdirSync(folder).find((name) => name.endsWith('.tmp'))
    if (!staged) throw new Error('expected a staged file')
    await volume.move('evil', staged)
    finish()
    expect(['not-found', 'outside-workspace']).toContain(await codeOf(writing))
    expect(fs.readFileSync(path.join(folder, 'b.txt'), 'utf8')).toBe('old')
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('refuses to publish an upload staged through a link that was put back before it finished', async () => {
    await fs.promises.mkdir(path.join(folder, 'd'))
    await fs.promises.mkdir(path.join(folder, 'real'))
    const write = LocalFileOps.prototype.write
    const spy = vi.spyOn(LocalFileOps.prototype, 'write').mockImplementation(async function (this: LocalFileOps, target, content, options) {
      await fs.promises.rename(path.join(folder, 'd'), path.join(folder, 'd-old'))
      await fs.promises.symlink(path.join(folder, 'real'), path.join(folder, 'd'))
      const beforePublish = options?.beforePublish
      return write.call(this, target, content, {
        ...options,
        beforePublish: beforePublish && (async (destination) => {
          await fs.promises.unlink(path.join(folder, 'd'))
          await fs.promises.rename(path.join(folder, 'd-old'), path.join(folder, 'd'))
          return beforePublish(destination)
        }),
      })
    })
    try {
      expect(await codeOf(volume.write('d/x.txt', new Blob(['x']).stream()))).toBe('not-accessible')
      expect(fs.readdirSync(path.join(folder, 'real'))).toEqual([])
      expect(fs.readdirSync(path.join(folder, 'd'))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('stages nothing outside when its folder is swapped for a link before the upload starts', async () => {
    const write = LocalFileOps.prototype.write
    let stagedOutside: string[] = []
    const spy = vi.spyOn(LocalFileOps.prototype, 'write').mockImplementation(async function (this: LocalFileOps, target, content, options) {
      await fs.promises.rename(folder, `${folder}-moved`)
      await fs.promises.symlink(outside, folder)
      const beforePublish = options?.beforePublish
      return write.call(this, target, content, {
        ...options,
        beforePublish: beforePublish && (async (destination) => {
          stagedOutside = fs.readdirSync(outside).filter((name) => name.endsWith('.tmp'))
          return beforePublish(destination)
        }),
      })
    })
    try {
      expect(await codeOf(volume.write('x.txt', new Blob(['x']).stream()))).toBe('not-found')
      expect(stagedOutside).toEqual([])
      expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses a move into a link that leads out of the folder', async () => {
    await fs.promises.writeFile(path.join(folder, 'a.txt'), 'a')
    await fs.promises.symlink(outside, path.join(folder, 'escape'))
    expect(await codeOf(volume.move('a.txt', 'escape/a.txt'))).toBe('outside-workspace')
    expect(fs.existsSync(path.join(outside, 'a.txt'))).toBe(false)
  })

  it('writes a whole file, then reads it back whole and by range', async () => {
    await volume.write('notes.txt', new Blob(['hello world']).stream())
    expect(await text((await volume.read('notes.txt')).stream())).toBe('hello world')
    const file = await volume.read('notes.txt')
    expect(file.size).toBe(11)
    expect(await text(file.stream({ start: 6, end: 10 }))).toBe('world')
    expect(await volume.stat('notes.txt')).toMatchObject({ name: 'notes.txt', kind: 'file', size: 11 })
  })
})
