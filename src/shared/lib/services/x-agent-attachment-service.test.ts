import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'
import type { FileOps, OpenFile } from '@shared/lib/agent-actor/types'
import { normalizeXAgentAttachmentPaths, transferXAgentAttachments, transferError, XAgentAttachmentError } from './x-agent-attachment-service'
import { MAX_X_AGENT_ATTACHMENT_BYTES } from './x-agent-attachment-schema'

describe('normalizeXAgentAttachmentPaths', () => {
  it('normalizes relative and absolute workspace paths', () => {
    expect(normalizeXAgentAttachmentPaths(['reports/a.txt', '/workspace/data/b.csv']))
      .toEqual(['/workspace/reports/a.txt', '/workspace/data/b.csv'])
  })

  it.each([
    '',
    '.',
    '/workspace',
    '../outside',
    'folder/../../outside',
    '..\\outside',
    '/workspace/../outside',
    '/workspace-sibling/file',
    '/etc/passwd',
    'C:\\outside',
    'bad\0path',
  ])('rejects unsafe path %j', (candidate) => {
    expect(() => normalizeXAgentAttachmentPaths([candidate])).toThrow()
  })

  it('rejects more than ten attachments', () => {
    expect(() => normalizeXAgentAttachmentPaths(Array.from({ length: 11 }, (_, i) => `file-${i}`)))
      .toThrow()
  })
})

describe('transferXAgentAttachments through local FileOps', () => {
  let root: string
  let source: FileOps
  let target: FileOps
  const targetDirectory = '/workspace/uploads/x-agent/test-transfer'
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-fileops-'))
    await fs.mkdir(path.join(root, 'source'))
    await fs.mkdir(path.join(root, 'target'))
    source = new LocalFileOps(() => path.join(root, 'source'))
    target = new LocalFileOps(() => path.join(root, 'target'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })
  const transfer = (paths: string[], signal?: AbortSignal) => transferXAgentAttachments({
    sourceFiles: source, targetFiles: target, sourcePaths: paths, transferId: 'test-transfer', signal,
  })
  it('copies binary, empty and URL-special names to isolated paths without decoding or hard links', async () => {
    // S3 Files (cloud /workspace) rejects every link() with EMLINK.
    const link = vi.spyOn(nodeFs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('EMLINK: too many links, link'), { code: 'EMLINK' }),
    )
    const bytes = Uint8Array.from([0, 255, 128, 1])
    await source.putDoc('a/report.bin', bytes)
    await source.putDoc('b/report.bin', 'second')
    await source.putDoc('a folder/hash#query?.txt', '')
    const result = await transfer(['a/report.bin', 'b/report.bin', 'a folder/hash#query?.txt'])
    expect(result.attachments.map((file) => file.targetPath)).toEqual([
      `${targetDirectory}/0/report.bin`, `${targetDirectory}/1/report.bin`, `${targetDirectory}/2/hash_query_.txt`,
    ])
    expect(await target.getDoc(result.attachments[0].targetPath)).toEqual(Buffer.from(bytes))
    expect(Buffer.from((await target.getDoc(result.attachments[1].targetPath))!).toString()).toBe('second')
    expect(await target.getDoc(result.attachments[2].targetPath)).toHaveLength(0)
    expect(await fs.readdir(path.join(root, 'target/uploads/x-agent/test-transfer/0'))).toEqual(['report.bin'])
    expect(link).not.toHaveBeenCalled()
  })
  it('cleans completed files when a later source is absent', async () => {
    await source.putDoc('first', 'bytes')
    await expect(transfer(['first', 'missing'])).rejects.toMatchObject({ status: 404 })
    expect(await target.stat(targetDirectory)).toBeNull()
  })
  it.each([2, 10])('preserves 409 and cleans partial data on a stream size mismatch: %s', async (size) => {
    vi.spyOn(source, 'open').mockResolvedValue({
      size: async () => size, stream: () => new Response('short').body!, close: vi.fn(async () => {}), readAt: vi.fn(),
    })
    await expect(transfer(['changing'])).rejects.toMatchObject({ status: 409 })
    expect(await target.stat(targetDirectory)).toBeNull()
  })
  it('unwraps typed stream failures from lower-level causes', () => {
    const cause = new XAgentAttachmentError('File changed', 409)
    expect(transferError(new TypeError('fetch failed', { cause }))).toBe(cause)
  })
  it('closes an oversized source before reading it', async () => {
    const file: OpenFile = { size: async () => MAX_X_AGENT_ATTACHMENT_BYTES + 1, stream: vi.fn(), close: vi.fn(async () => {}), readAt: vi.fn() }
    vi.spyOn(source, 'open').mockResolvedValue(file)
    await expect(transfer(['large'])).rejects.toMatchObject({ status: 413 })
    expect(file.close).toHaveBeenCalledOnce()
    expect(file.stream).not.toHaveBeenCalled()
  })
  it('refuses symlink escapes when reading, writing, and cleaning up', async () => {
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret'), 'secret')
    await fs.symlink(outside, path.join(root, 'source', 'linked'))
    await expect(transfer(['linked/secret'])).rejects.toMatchObject({ status: 400 })
    await source.putDoc('safe', 'safe')
    await fs.symlink(outside, path.join(root, 'target', 'uploads'))
    await expect(transfer(['safe'])).rejects.toMatchObject({ status: 400 })
    await expect(target.delete('uploads/secret', { confined: true })).rejects.toMatchObject({ code: 'outside-workspace' })
    expect(await fs.readdir(outside)).toEqual(['secret'])
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('secret')
  })
  it('rejects directories as sources', async () => {
    await source.mkdir('directory')
    await expect(transfer(['directory'])).rejects.toMatchObject({ status: 404 })
  })
  it('does not overwrite a racing destination', async () => {
    await source.putDoc('safe', 'new')
    const writeFile = fs.writeFile
    // Inject the race at the publication claim, after all preflight checks.
    vi.spyOn(nodeFs.promises, 'writeFile').mockImplementationOnce(async (to, data, options) => {
      expect(options).toMatchObject({ flag: 'wx' })
      // Empty, so a cleanup that mistook it for our claim would remove it.
      await writeFile(to, '')
      return writeFile(to, data, options)
    })
    await expect(target.write('race', new TextEncoder().encode('new'), { confined: true, overwrite: false }))
      .rejects.toMatchObject({ code: 'already-exists' })
    expect(Buffer.from((await target.getDoc('race'))!).toString()).toBe('')
    expect(await fs.readdir(path.join(root, 'target'))).toEqual(['race'])
  })
  it.each([
    ['removes an empty claim', '', []],
    ['keeps a claim another writer filled', 'existing', ['race']],
  ])('%s when publication fails', async (_case, racing, remaining) => {
    vi.spyOn(nodeFs.promises, 'rename').mockImplementationOnce(async (_from, to) => {
      expect(await fs.readFile(to, 'utf8')).toBe('')
      if (racing) await fs.writeFile(to, racing)
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
    })
    await expect(target.write('race', new TextEncoder().encode('new'), { confined: true, overwrite: false }))
      .rejects.toMatchObject({ code: 'EIO' })
    expect(await fs.readdir(path.join(root, 'target'))).toEqual(remaining)
    if (racing) expect(await fs.readFile(path.join(root, 'target', 'race'), 'utf8')).toBe(racing)
  })
  it('cancels an interrupted transfer and removes partial data', async () => {
    const abort = new AbortController()
    const cancel = vi.fn()
    vi.spyOn(source, 'open').mockResolvedValue({
      size: async () => 10, close: vi.fn(async () => {}), readAt: vi.fn(),
      stream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel }),
    })
    const writing = transfer(['waiting'], abort.signal)
    await vi.waitFor(async () => expect(await target.stat(targetDirectory)).not.toBeNull())
    abort.abort()
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(await target.stat(targetDirectory)).toBeNull()
  })
})
