/**
 * The `FileOps` contract as a test suite. Every implementation — the local
 * directory, the in-memory fake, and whatever a remote actor brings — runs
 * the same cases, so the contract is the tests rather than the prose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileOps } from '../types'
import { WorkspaceFileError } from '../workspace-path'
import { readAllBytes } from './in-memory-file-ops'

export interface FileOpsHarness {
  files: FileOps
  dispose?: () => Promise<void> | void
}

const text = (s: string) => new TextEncoder().encode(s)
const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error.code
    throw error
  }
  throw new Error('expected a WorkspaceFileError')
}

export function describeFileOpsContract(name: string, make: () => Promise<FileOpsHarness> | FileOpsHarness): void {
  describe(`${name} — FileOps contract`, () => {
    let harness: FileOpsHarness
    let files: FileOps

    beforeEach(async () => {
      harness = await make()
      files = harness.files
    })

    afterEach(async () => {
      await harness.dispose?.()
    })

    it('starts as an empty root directory', async () => {
      expect(await files.list('')).toEqual([])
      expect(await files.stat('')).toMatchObject({ kind: 'directory' })
      expect(await files.stat('anything')).toBeNull()
    })

    it('putDoc then getDoc round-trips text and bytes, creating parent directories', async () => {
      await files.putDoc('notes/today.txt', 'hello')
      await files.putDoc('bin/blob', new Uint8Array([0, 1, 2, 255]))

      expect(decode(await files.getDoc('notes/today.txt'))).toBe('hello')
      expect(Array.from((await files.getDoc('bin/blob')) ?? [])).toEqual([0, 1, 2, 255])
      expect(await files.stat('notes')).toMatchObject({ kind: 'directory' })
      expect(await files.stat('notes/today.txt')).toMatchObject({ kind: 'file', size: 5 })
    })

    it('resolve answers where a path really is: the path itself when present, null when absent', async () => {
      await files.putDoc('notes/today.txt', 'hello')
      expect(await files.resolve('notes/today.txt')).toBe('notes/today.txt')
      expect(await files.resolve('/workspace/notes/')).toBe('notes')
      expect(await files.resolve('')).toBe('')
      expect(await files.resolve('notes/missing.txt')).toBeNull()
    })

    it('accepts a file name as long as a filesystem allows', async () => {
      // 240 bytes: a name the filesystem takes, with no room for a suffix.
      const long = `${'n'.repeat(236)}.txt`
      await files.putDoc(`docs/${long}`, 'doc')
      expect(await files.write(`uploads/${long}`, text('upload'))).toEqual({ size: 6 })
      expect(decode(await files.getDoc(`docs/${long}`))).toBe('doc')
      expect((await files.list('uploads')).map((entry) => entry.name)).toEqual([long])
    })

    it('putDoc replaces the whole document', async () => {
      await files.putDoc('doc.json', '{"a":1}')
      await files.putDoc('doc.json', '{"b":2}')
      expect(decode(await files.getDoc('doc.json'))).toBe('{"b":2}')
    })

    it('an absent path reads as null from getDoc and stat, and read throws not-found', async () => {
      expect(await files.getDoc('missing.txt')).toBeNull()
      expect(await files.stat('missing.txt')).toBeNull()
      expect(await codeOf(files.read('missing.txt'))).toBe('not-found')
    })

    it('write streams bytes and reports the size; read returns them whole or by closed byte range', async () => {
      const payload = text('0123456789')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.slice(0, 4))
          controller.enqueue(payload.slice(4))
          controller.close()
        },
      })

      expect(await files.write('uploads/digits.txt', stream)).toEqual({ size: 10 })
      expect(decode(await readAllBytes(await files.read('uploads/digits.txt')))).toBe('0123456789')
      expect(decode(await readAllBytes(await files.read('uploads/digits.txt', { start: 2, end: 4 })))).toBe('234')
      expect(await codeOf(files.read('uploads/digits.txt', { start: 5, end: 40 }))).toBe('invalid-path')

      expect(await files.write('uploads/raw.bin', new Uint8Array([9, 8, 7]))).toEqual({ size: 3 })
    })

    it('list returns immediate children with kinds and their own paths', async () => {
      await files.putDoc('a/one.txt', '1')
      await files.putDoc('a/b/two.txt', '2')
      await files.putDoc('top.txt', 't')

      const root = await files.list('')
      expect(root.map((entry) => [entry.name, entry.kind, entry.path]).sort()).toEqual([
        ['a', 'directory', 'a'],
        ['top.txt', 'file', 'top.txt'],
      ])
      const nested = await files.list('/workspace/a')
      expect(nested.map((entry) => [entry.name, entry.kind, entry.path]).sort()).toEqual([
        ['b', 'directory', 'a/b'],
        ['one.txt', 'file', 'a/one.txt'],
      ])
    })

    it('list of a file is not-a-directory and list of an absent directory is not-found', async () => {
      await files.putDoc('file.txt', 'x')
      expect(await codeOf(files.list('file.txt'))).toBe('not-a-directory')
      expect(await codeOf(files.list('nope'))).toBe('not-found')
    })

    it('a directory is not a file: read and getDoc refuse it', async () => {
      await files.mkdir('dir')
      expect(await codeOf(files.read('dir'))).toBe('not-a-file')
      expect(await codeOf(files.getDoc('dir'))).toBe('not-a-file')
      expect(await codeOf(files.putDoc('dir', 'x'))).toBe('not-a-file')
    })

    it('delete removes a file, needs recursive for a directory, and ignores an absent path', async () => {
      await files.putDoc('d/x.txt', 'x')
      await files.putDoc('d/e/y.txt', 'y')

      await files.delete('d/x.txt')
      expect(await files.stat('d/x.txt')).toBeNull()

      expect(await codeOf(files.delete('d'))).toBe('not-a-file')
      expect(await files.stat('d/e/y.txt')).toMatchObject({ kind: 'file' })

      await files.delete('d', { recursive: true })
      expect(await files.stat('d')).toBeNull()
      expect(await files.stat('d/e/y.txt')).toBeNull()

      await expect(files.delete('never-there')).resolves.toBeUndefined()
    })

    it('mkdir creates nested directories and refuses to go through a file', async () => {
      await files.mkdir('x/y/z')
      expect(await files.stat('x/y/z')).toMatchObject({ kind: 'directory' })
      expect(await files.list('x/y')).toEqual([{ name: 'z', path: 'x/y/z', kind: 'directory' }])

      await files.putDoc('f.txt', 'f')
      expect(await codeOf(files.mkdir('f.txt/child'))).toBe('not-a-directory')
      expect(await codeOf(files.putDoc('f.txt/child', 'x'))).toBe('not-a-directory')
    })

    it('the root cannot be written as a file or deleted', async () => {
      expect(await codeOf(files.putDoc('', 'x'))).toBe('invalid-path')
      expect(await codeOf(files.putDoc('/workspace', 'x'))).toBe('invalid-path')
      expect(await codeOf(files.delete('', { recursive: true }))).toBe('invalid-path')
      await expect(files.mkdir('')).resolves.toBeUndefined()
    })

    it('accepts the /workspace and ./ spellings of the same path', async () => {
      await files.putDoc('/workspace/uploads/a.txt', 'a')
      expect(decode(await files.getDoc('uploads/a.txt'))).toBe('a')
      expect(decode(await files.getDoc('./uploads/a.txt'))).toBe('a')
      expect(decode(await files.getDoc('uploads//a.txt'))).toBe('a')
      expect(await files.stat('/workspace/uploads/')).toMatchObject({ kind: 'directory' })
    })

    it.each([
      '../escape',
      '/etc/passwd',
      '/workspace/../escape',
      'a/../../escape',
      'a/\0b',
      '..',
    ])('rejects %j before touching anything', async (bad) => {
      for (const attempt of [
        files.stat(bad),
        files.resolve(bad),
        files.getDoc(bad),
        files.read(bad),
        files.list(bad),
        files.putDoc(bad, 'x'),
        files.write(bad, new Uint8Array([1])),
        files.delete(bad, { recursive: true }),
        files.mkdir(bad),
      ]) {
        const code = await codeOf(attempt)
        expect(['invalid-path', 'outside-workspace']).toContain(code)
      }
      expect(await files.list('')).toEqual([])
    })
  })
}
