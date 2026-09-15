import { describe, expect, it } from 'vitest'
import {
  ModalVolumeError,
  ModalVolumeFiles,
  VOLUME_BLOCK_SIZE,
  expectedBlockLengths,
  planBlocks,
  translateVolumeError,
} from './modal-volume'
import { FakeVolumeControlPlane } from './testing/fake-volume-control-plane'

function grpc(code: number, details: string): Error {
  return Object.assign(new Error(`/ModalClient/Volume ${code}: ${details}`), { code, details })
}

describe('block planning', () => {
  it('splits a file into 8 MiB blocks and hashes each without its trailing zero bytes', () => {
    const bytes = new Uint8Array(VOLUME_BLOCK_SIZE + 5)
    bytes.set([1, 2, 3], 0)
    bytes.set([9], VOLUME_BLOCK_SIZE + 1)
    const blocks = planBlocks(bytes)
    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      [0, 3],
      [VOLUME_BLOCK_SIZE, VOLUME_BLOCK_SIZE + 2],
    ])
    // The hash covers exactly the trimmed content, so [1,2,3] hashes the same wherever the zeros end.
    expect(blocks[0].sha256).toEqual(planBlocks(new Uint8Array([1, 2, 3, 0, 0]))[0].sha256)
  })

  it('an empty file has no blocks and an all-zero block hashes as empty', () => {
    expect(planBlocks(new Uint8Array(0))).toEqual([])
    const zeros = planBlocks(new Uint8Array(10))
    expect(zeros).toHaveLength(1)
    expect(zeros[0]).toMatchObject({ start: 0, end: 0 })
  })

  it('expected block lengths follow block alignment from the range start', () => {
    expect(expectedBlockLengths(0, 10, 1)).toEqual([10])
    expect(expectedBlockLengths(VOLUME_BLOCK_SIZE - 4, 10, 2)).toEqual([4, 6])
    expect(expectedBlockLengths(0, VOLUME_BLOCK_SIZE * 2 + 1, 3)).toEqual([VOLUME_BLOCK_SIZE, VOLUME_BLOCK_SIZE, 1])
  })
})

describe('translateVolumeError', () => {
  const codeOf = (error: unknown) => {
    try {
      translateVolumeError(error)
    } catch (translated) {
      return translated instanceof ModalVolumeError ? translated.code : translated
    }
    return 'did not throw'
  }

  it('maps the volume status codes and messages onto the contract codes', () => {
    expect(codeOf(grpc(5, 'path "/x" does not exist'))).toBe('not-found')
    expect(codeOf(grpc(9, 'path "/f/x" contains a non-directory parent: "/f"'))).toBe('not-a-directory')
    expect(codeOf(grpc(9, 'path "/d" is a directory'))).toBe('is-a-directory')
    expect(codeOf(grpc(9, 'directory "/d" is not empty'))).toBe('directory-not-empty')
    expect(codeOf(grpc(3, 'path "/x" already exists'))).toBe('already-exists')
  })

  it('rethrows anything else untouched', () => {
    const unknown = grpc(13, 'internal')
    expect(codeOf(unknown)).toBe(unknown)
    const plain = new Error('network')
    expect(codeOf(plain)).toBe(plain)
  })
})

describe('ModalVolumeFiles against an emulated volume', () => {
  const make = async () => {
    const fake = new FakeVolumeControlPlane()
    const volume = await ModalVolumeFiles.ensure('fake', fake.deps)
    return { fake, volume }
  }

  it('uploads a multi-block file in two rounds and re-uploading the same bytes needs no blocks', async () => {
    const { fake, volume } = await make()
    const bytes = new Uint8Array(VOLUME_BLOCK_SIZE + 100)
    bytes.set([7, 7, 7], 0)
    bytes.set([1, 2], VOLUME_BLOCK_SIZE + 10)

    await volume.put('big/file.bin', bytes)
    expect(fake.calls.filter((call) => call === 'volumePutFiles2')).toHaveLength(2)
    expect(Buffer.from(await volume.read('big/file.bin')).equals(Buffer.from(bytes))).toBe(true)

    fake.calls.length = 0
    await volume.put('big/copy.bin', bytes)
    // The blocks are already in the volume: one round, nothing missing.
    expect(fake.calls).toEqual(['volumePutFiles2'])
    expect((await volume.entry('big/copy.bin'))?.size).toBe(bytes.length)
  })

  it('reads a byte range across a block boundary, restoring the zero bytes the server left off', async () => {
    const { volume } = await make()
    const bytes = new Uint8Array(VOLUME_BLOCK_SIZE + 8)
    bytes.set([5, 0, 0, 0], VOLUME_BLOCK_SIZE - 2)
    bytes.set([6], VOLUME_BLOCK_SIZE + 7)
    await volume.put('spanning.bin', bytes)

    const range = await volume.read('spanning.bin', { start: VOLUME_BLOCK_SIZE - 2, end: VOLUME_BLOCK_SIZE + 7 })
    expect(Array.from(range)).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 0, 6])
    expect((await volume.readStream('spanning.bin')).size).toBe(bytes.length)
  })

  it('lists, stats, removes and copies with the contract errors', async () => {
    const { volume } = await make()
    await volume.put('a/one.txt', new TextEncoder().encode('1'))
    await volume.put('a/b/two.txt', new TextEncoder().encode('2'))

    expect((await volume.list('a')).map((entry) => [entry.path, entry.kind])).toEqual([
      ['a/b', 'directory'],
      ['a/one.txt', 'file'],
    ])
    expect((await volume.list('a', true)).map((entry) => entry.path)).toEqual(['a/b', 'a/b/two.txt', 'a/one.txt'])
    expect(await volume.entry('a')).toMatchObject({ kind: 'directory' })
    expect(await volume.entry('a/one.txt')).toMatchObject({ kind: 'file', size: 1 })
    expect(await volume.entry('a/missing')).toBeNull()
    expect(await volume.entry('a/one.txt/child')).toBeNull()

    await expect(volume.remove('a')).rejects.toMatchObject({ code: 'directory-not-empty' })
    await volume.copy('a/one.txt', 'a/renamed.txt')
    await volume.remove('a/one.txt')
    expect((await volume.list('a')).map((entry) => entry.path)).toEqual(['a/b', 'a/renamed.txt'])
    await expect(volume.remove('a/one.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(volume.read('a')).rejects.toMatchObject({ code: 'is-a-directory' })
    await expect(volume.put('a/renamed.txt', new Uint8Array([1]), { overwrite: false })).rejects.toMatchObject({
      code: 'already-exists',
    })

    await volume.remove('a', true)
    await expect(volume.list('a')).rejects.toMatchObject({ code: 'not-found' })
  })
})
