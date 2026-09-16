import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractWorkspaceFileRoutePath,
  normalizeWorkspaceFilePath,
  openWorkspaceFile,
  removeWorkspacePath,
  resolveWorkspaceRegularFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from './workspace-file-transfer'

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('workspace file transfer', () => {
  let workspace: string
  let sibling: string

  beforeEach(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-transfer-'))
    sibling = `${workspace}-sibling`
    await fs.promises.mkdir(sibling)
  })

  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true })
    await fs.promises.rm(sibling, { recursive: true, force: true })
  })

  it.each([
    '../outside',
    'folder/../../outside',
    '..\\outside',
    '/workspace/../outside',
    '/workspace-sibling/file',
    '/etc/passwd',
    'C:\\outside',
  ])('rejects traversal or absolute escape %s', (candidate) => {
    expect(() => normalizeWorkspaceFilePath(candidate, workspace)).toThrow(WorkspaceFileError)
  })

  it.each(['', '.', '/', '/workspace', '/workspace/'])('rejects workspace root %s', (candidate) => {
    expect(() => normalizeWorkspaceFilePath(candidate, workspace)).toThrow(WorkspaceFileError)
  })

  it('rejects NUL bytes', () => {
    expect(() => normalizeWorkspaceFilePath('safe\0unsafe', workspace)).toThrow('Invalid workspace file path')
  })

  it('normalizes relative and absolute /workspace paths', () => {
    expect(normalizeWorkspaceFilePath('./folder/file.txt', workspace).relativePath).toBe('folder/file.txt')
    expect(normalizeWorkspaceFilePath('/workspace/folder/file.txt', workspace).localPath)
      .toBe(path.join(workspace, 'folder', 'file.txt'))
  })

  it('opens empty and binary files without decoding', async () => {
    await fs.promises.writeFile(path.join(workspace, 'empty.bin'), Buffer.alloc(0))
    const bytes = Buffer.from([0, 255, 1, 128, 10])
    await fs.promises.writeFile(path.join(workspace, 'bytes.bin'), bytes)

    const empty = await openWorkspaceFile('empty.bin', workspace)
    expect(empty.size).toBe(0)
    expect(await streamBytes(empty.stream)).toEqual(Buffer.alloc(0))

    const binary = await openWorkspaceFile('/workspace/bytes.bin', workspace)
    expect(binary.size).toBe(bytes.length)
    expect(await streamBytes(binary.stream)).toEqual(bytes)
  })

  it('keeps an empty-file response empty if the file grows after opening', async () => {
    const filePath = path.join(workspace, 'empty-then-grown.bin')
    await fs.promises.writeFile(filePath, Buffer.alloc(0))
    const file = await openWorkspaceFile('empty-then-grown.bin', workspace)
    await fs.promises.appendFile(filePath, 'x')

    expect(await streamBytes(file.stream)).toEqual(Buffer.alloc(0))
  })

  it('rejects missing paths, directories, and non-regular symlink escapes', async () => {
    await fs.promises.mkdir(path.join(workspace, 'directory'))
    await fs.promises.symlink('/dev/null', path.join(workspace, 'device-link'))

    await expect(resolveWorkspaceRegularFile('missing', workspace)).rejects.toMatchObject({ status: 404 })
    await expect(resolveWorkspaceRegularFile('directory', workspace)).rejects.toThrow('not a regular file')
    await expect(resolveWorkspaceRegularFile('device-link', workspace)).rejects.toThrow('outside /workspace')
  })

  it('rejects canonical escapes through a sibling-prefix symlink', async () => {
    await fs.promises.writeFile(path.join(sibling, 'secret.txt'), 'secret')
    await fs.promises.symlink(sibling, path.join(workspace, 'linked'))

    await expect(openWorkspaceFile('linked/secret.txt', workspace)).rejects.toMatchObject({ status: 403 })
  })

  it('writes binary and empty bodies atomically while creating parents', async () => {
    const bytes = Buffer.from([0, 255, 2, 128])
    const binary = await writeWorkspaceFile('/workspace/nested/output.bin', Readable.from(bytes), { workspaceRoot: workspace })
    const empty = await writeWorkspaceFile('nested/empty.bin', null, { workspaceRoot: workspace })

    expect(binary.relativePath).toBe('nested/output.bin')
    expect(binary.size).toBe(bytes.length)
    expect(await fs.promises.readFile(binary.localPath)).toEqual(bytes)
    expect(empty.size).toBe(0)
    expect(await fs.promises.readFile(empty.localPath)).toEqual(Buffer.alloc(0))
  })

  it.each([220, 255])('writes a valid %i-byte filename with bounded staging names', async (length) => {
    const name = 'a'.repeat(length - 4) + '.pdf'
    const written = await writeWorkspaceFile(name, Readable.from('original'), {
      workspaceRoot: workspace,
      overwrite: false,
    })
    expect(await fs.promises.readFile(written.localPath, 'utf8')).toBe('original')
    await writeWorkspaceFile(name, Readable.from('updated'), { workspaceRoot: workspace })
    expect(await fs.promises.readFile(written.localPath, 'utf8')).toBe('updated')
    expect(await fs.promises.readdir(workspace)).toEqual([name])
  })

  it.each([0o755, 0o640])('preserves mode %i when overwriting an existing file', async (mode) => {
    const destination = path.join(workspace, 'run.sh')
    await fs.promises.writeFile(destination, 'old')
    await fs.promises.chmod(destination, mode)
    await writeWorkspaceFile('run.sh', Readable.from('new'), { workspaceRoot: workspace })
    expect((await fs.promises.stat(destination)).mode & 0o7777).toBe(mode)
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('new')
  })

  it('rejects an escaping parent symlink without writing outside', async () => {
    await fs.promises.symlink(sibling, path.join(workspace, 'linked'))

    await expect(writeWorkspaceFile('linked/escaped.bin', Readable.from('no'), { workspaceRoot: workspace }))
      .rejects.toThrow('Destination parent resolves outside /workspace')
    await expect(fs.promises.stat(path.join(sibling, 'escaped.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a final destination symlink', async () => {
    const outside = path.join(sibling, 'outside.txt')
    await fs.promises.writeFile(outside, 'untouched')
    await fs.promises.symlink(outside, path.join(workspace, 'output.txt'))

    await expect(writeWorkspaceFile('output.txt', Readable.from('replacement'), { workspaceRoot: workspace }))
      .rejects.toThrow('must not be a symbolic link')
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('untouched')
  })

  it('removes partial temporary files when the input stream fails', async () => {
    const interrupted = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('interrupted'))
      },
    })

    await expect(writeWorkspaceFile('nested/result.bin', interrupted, { workspaceRoot: workspace }))
      .rejects.toThrow('interrupted')
    expect(await fs.promises.readdir(path.join(workspace, 'nested'))).toEqual([])
  })

  it('removes partial temporary files when the write is aborted', async () => {
    const controller = new AbortController()
    const source = new Readable({ read() {} })
    source.push(Buffer.from('partial'))
    const writing = writeWorkspaceFile('nested/aborted.bin', source, {
      workspaceRoot: workspace,
      signal: controller.signal,
    })
    controller.abort()

    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    source.destroy()
    expect(await fs.promises.readdir(path.join(workspace, 'nested'))).toEqual([])
  })

  it('selects extension-preserving collision names without overwriting', async () => {
    await fs.promises.writeFile(path.join(workspace, 'report.pdf'), 'first')
    const result = await writeWorkspaceFile('report.pdf', Readable.from('second'), {
      workspaceRoot: workspace,
      collisionSafe: true,
    })

    expect(result.relativePath).toBe('report-1.pdf')
    expect(await fs.promises.readFile(path.join(workspace, 'report.pdf'), 'utf8')).toBe('first')
    expect(await fs.promises.readFile(result.localPath, 'utf8')).toBe('second')
    expect((await fs.promises.readdir(workspace)).sort()).toEqual(['report-1.pdf', 'report.pdf'])
  })

  it('removes a confined directory tree', async () => {
    const directory = path.join(workspace, 'uploads', 'x-agent', 'transfer-id')
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(path.join(directory, 'file.bin'), 'bytes')

    await removeWorkspacePath('/workspace/uploads/x-agent/transfer-id', workspace)

    await expect(fs.promises.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses cleanup through an escaping symlink', async () => {
    await fs.promises.writeFile(path.join(sibling, 'untouched.txt'), 'untouched')
    await fs.promises.symlink(sibling, path.join(workspace, 'linked'))

    await expect(removeWorkspacePath('/workspace/linked', workspace)).rejects.toThrow('must not be a symbolic link')
    expect(await fs.promises.readFile(path.join(sibling, 'untouched.txt'), 'utf8')).toBe('untouched')
  })
})

describe('workspace file route extraction', () => {
  it.each([
    'space name.bin',
    'hash#name.bin',
    'query?name.bin',
    'percent%name.bin',
    'unicode-\u00e9.bin',
  ])('preserves URL-special filename %s', (filename) => {
    const encoded = encodeURIComponent(filename)
    expect(extractWorkspaceFileRoutePath(`http://container/workspace-files/content/${encoded}`, 'content')).toBe(filename)
  })

  it('uses an exact terminal route suffix', () => {
    expect(extractWorkspaceFileRoutePath('http://container/workspace-files/upload/a/upload-name', 'upload')).toBe('a/upload-name')
    expect(extractWorkspaceFileRoutePath('http://container/workspace-files/delete/a/nested', 'delete')).toBe('a/nested')
    expect(() => extractWorkspaceFileRoutePath('http://container/workspace-files/upload/', 'upload')).toThrow('Invalid file route')
  })

  it('rejects malformed URL encoding', () => {
    expect(() => extractWorkspaceFileRoutePath('http://container/workspace-files/content/bad%ZZ', 'content'))
      .toThrow('Invalid encoded file path')
  })
})
