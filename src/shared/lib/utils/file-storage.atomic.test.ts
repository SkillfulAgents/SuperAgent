/**
 * Foundational atomic-write / per-path write-queue / strict JSON reader
 * primitives in file-storage.ts.
 *
 * These back the codebase-wide file-storage hardening. They are
 * sensitive infra: a regression here silently re-opens the data-loss bug-class
 * so the coverage below is deliberately exhaustive — atomicity &
 * crash-safety, fail-closed reads, and read-modify-write serialization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { z } from 'zod'
import {
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
  writeJsonFile,
  readJsonFileStrict,
  readJsonFileStrictSync,
  withFileLock,
  withCrossProcessFileLock,
  CorruptFileError,
} from './file-storage'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-storage-atomic-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Sibling `.tmp` files our atomic writer creates; none should survive a call. */
function leftoverTmpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
}

describe('writeFileAtomic / writeFileAtomicSync', () => {
  it('writes content and leaves no temp files behind (async)', async () => {
    const p = path.join(tmpDir, 'a.txt')
    await writeFileAtomic(p, 'hello')
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello')
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('writes content and leaves no temp files behind (sync)', () => {
    const p = path.join(tmpDir, 'b.txt')
    writeFileAtomicSync(p, 'world')
    expect(fs.readFileSync(p, 'utf-8')).toBe('world')
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('overwrites an existing file atomically (replaces content)', async () => {
    const p = path.join(tmpDir, 'c.txt')
    fs.writeFileSync(p, 'old')
    await writeFileAtomic(p, 'new')
    expect(fs.readFileSync(p, 'utf-8')).toBe('new')
  })

  it.runIf(process.platform !== 'win32')('honors an explicit mode (0o600) regardless of umask', async () => {
    const p = path.join(tmpDir, 'secret.txt')
    await writeFileAtomic(p, 'api-key', { mode: 0o600 })
    const mode = fs.statSync(p).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it.runIf(process.platform !== 'win32')('honors an explicit mode (sync)', () => {
    const p = path.join(tmpDir, 'secret-sync.txt')
    writeFileAtomicSync(p, 'api-key', { mode: 0o600 })
    expect(fs.statSync(p).mode & 0o777).toBe(0o600)
  })

  it('a failed write leaves the previous good file intact and no temp file (async)', async () => {
    // Make the target path a directory so the final rename(tmp -> target) fails;
    // the writer must clean up its temp file and surface the error without
    // touching the existing directory. This is the "partial .tmp never replaces
    // a good target" crash-safety property.
    const target = path.join(tmpDir, 'is-a-dir')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'precious')

    await expect(writeFileAtomic(target, 'garbage')).rejects.toThrow()

    expect(fs.statSync(target).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('precious')
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('a failed write leaves the previous good file intact and no temp file (sync)', () => {
    const target = path.join(tmpDir, 'is-a-dir-sync')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'precious')

    expect(() => writeFileAtomicSync(target, 'garbage')).toThrow()

    expect(fs.statSync(target).isDirectory()).toBe(true)
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('throws (and cleans up) when the parent directory does not exist', async () => {
    const p = path.join(tmpDir, 'missing-dir', 'x.txt')
    await expect(writeFileAtomic(p, 'data')).rejects.toThrow()
    expect(fs.existsSync(path.join(tmpDir, 'missing-dir'))).toBe(false)
  })

  it('a successful overwrite never partially mutates the target', async () => {
    const p = path.join(tmpDir, 'good.json')
    fs.writeFileSync(p, JSON.stringify({ keep: true }))
    await writeFileAtomic(p, JSON.stringify({ keep: true, more: 1 }))
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ keep: true, more: 1 })
  })
})

describe('writeJsonFileAtomic / writeJsonFile (delegates to atomic)', () => {
  it('round-trips JSON (async atomic)', async () => {
    const p = path.join(tmpDir, 'data.json')
    await writeJsonFileAtomic(p, { a: 1, b: ['x', 'y'] })
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ a: 1, b: ['x', 'y'] })
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('round-trips JSON (sync atomic)', () => {
    const p = path.join(tmpDir, 'data-sync.json')
    writeJsonFileAtomicSync(p, { ok: true })
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ ok: true })
  })

  it('writeJsonFile is now atomic (no temp file leakage)', async () => {
    const p = path.join(tmpDir, 'legacy.json')
    await writeJsonFile(p, { migrated: true })
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ migrated: true })
    expect(leftoverTmpFiles(tmpDir)).toEqual([])
  })

  it('pretty-prints with 2-space indent (matches prior writeJsonFile format)', async () => {
    const p = path.join(tmpDir, 'pretty.json')
    await writeJsonFile(p, { a: 1 })
    expect(fs.readFileSync(p, 'utf-8')).toBe('{\n  "a": 1\n}')
  })
})

describe('readJsonFileStrict / readJsonFileStrictSync — fail-closed', () => {
  const schema = z.record(z.string(), z.object({ name: z.string().optional() }).loose())

  it('returns the fallback when the file is absent (ENOENT)', async () => {
    const p = path.join(tmpDir, 'nope.json')
    expect(await readJsonFileStrict(p, schema, {})).toEqual({})
    expect(readJsonFileStrictSync(p, schema, {})).toEqual({})
  })

  it('returns parsed+validated data for a valid file', async () => {
    const p = path.join(tmpDir, 'valid.json')
    fs.writeFileSync(p, JSON.stringify({ s1: { name: 'Session 1' } }))
    expect(await readJsonFileStrict(p, schema, {})).toEqual({ s1: { name: 'Session 1' } })
    expect(readJsonFileStrictSync(p, schema, {})).toEqual({ s1: { name: 'Session 1' } })
  })

  it('preserves unknown keys (forward-compatible, loose schema)', async () => {
    const p = path.join(tmpDir, 'extra.json')
    fs.writeFileSync(p, JSON.stringify({ s1: { name: 'x', futureField: 42 } }))
    const out = await readJsonFileStrict(p, schema, {})
    expect(out.s1).toEqual({ name: 'x', futureField: 42 })
  })

  it('THROWS CorruptFileError on a truncated/torn JSON file — never the fallback', async () => {
    const p = path.join(tmpDir, 'torn.json')
    fs.writeFileSync(p, '{ "s1": { "name": "Sessi') // half-written
    await expect(readJsonFileStrict(p, schema, {})).rejects.toBeInstanceOf(CorruptFileError)
    expect(() => readJsonFileStrictSync(p, schema, {})).toThrow(CorruptFileError)
  })

  it('THROWS CorruptFileError on an empty file (0 bytes)', async () => {
    const p = path.join(tmpDir, 'empty.json')
    fs.writeFileSync(p, '')
    await expect(readJsonFileStrict(p, schema, {})).rejects.toBeInstanceOf(CorruptFileError)
  })

  it('THROWS CorruptFileError when JSON is valid but the shape is wrong', async () => {
    const p = path.join(tmpDir, 'wrong-shape.json')
    fs.writeFileSync(p, JSON.stringify(['not', 'a', 'record']))
    await expect(readJsonFileStrict(p, schema, {})).rejects.toBeInstanceOf(CorruptFileError)
  })

  it('CorruptFileError carries the file path for recovery/forensics', async () => {
    const p = path.join(tmpDir, 'corrupt-path.json')
    fs.writeFileSync(p, 'not json')
    await expect(readJsonFileStrict(p, schema, {})).rejects.toMatchObject({ filePath: p })
  })

  it('rethrows non-ENOENT IO errors (does NOT swallow into the fallback)', async () => {
    // Reading a directory as a file yields EISDIR — must propagate, not default.
    const dirAsFile = path.join(tmpDir, 'a-directory')
    fs.mkdirSync(dirAsFile)
    await expect(readJsonFileStrict(dirAsFile, schema, {})).rejects.toThrow()
    // And it is NOT a CorruptFileError (it never got to JSON parsing).
    await expect(readJsonFileStrict(dirAsFile, schema, {})).rejects.not.toBeInstanceOf(CorruptFileError)
  })
})

describe('withFileLock — read-modify-write serialization', () => {
  // A read-modify-write that yields between read and write — the exact shape
  // that loses updates without serialization.
  async function rmwIncrement(p: string): Promise<void> {
    const cur = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf-8')) : 0
    await new Promise((r) => setTimeout(r, 1)) // force interleave window
    await writeFileAtomic(p, String(cur + 1))
  }

  it('UNSERIALIZED concurrent read-modify-write loses updates (proves the hazard)', async () => {
    const p = path.join(tmpDir, 'counter-unsafe.txt')
    fs.writeFileSync(p, '0')
    await Promise.all(Array.from({ length: 20 }, () => rmwIncrement(p)))
    // Lost updates: nowhere near 20.
    expect(Number(fs.readFileSync(p, 'utf-8'))).toBeLessThan(20)
  })

  it('serializes concurrent read-modify-write so EVERY update survives', async () => {
    const p = path.join(tmpDir, 'counter-safe.txt')
    fs.writeFileSync(p, '0')
    await Promise.all(Array.from({ length: 20 }, () => withFileLock(p, () => rmwIncrement(p))))
    expect(Number(fs.readFileSync(p, 'utf-8'))).toBe(20)
  })

  it('different paths run concurrently (lock is per-path, not global)', async () => {
    const order: string[] = []
    const a = withFileLock(path.join(tmpDir, 'A'), async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('a')
    })
    const b = withFileLock(path.join(tmpDir, 'B'), async () => {
      order.push('b') // should finish first despite being queued second
    })
    await Promise.all([a, b])
    expect(order).toEqual(['b', 'a'])
  })

  it('propagates the return value and the rejection of fn', async () => {
    const p = path.join(tmpDir, 'ret')
    expect(await withFileLock(p, async () => 42)).toBe(42)
    await expect(withFileLock(p, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })

  it('a rejecting locked section does not wedge later queued sections', async () => {
    const p = path.join(tmpDir, 'resilient')
    const results: string[] = []
    const failing = withFileLock(p, async () => { throw new Error('x') }).catch(() => results.push('failed'))
    const succeeding = withFileLock(p, async () => { results.push('ran') })
    await Promise.all([failing, succeeding])
    expect(results).toEqual(['failed', 'ran'])
  })

  it('queues callers in FIFO order for the same path', async () => {
    const p = path.join(tmpDir, 'fifo')
    const order: number[] = []
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        withFileLock(p, async () => {
          await new Promise((r) => setTimeout(r, 4 - i)) // earlier callers sleep longer
          order.push(i)
        })
      )
    )
    expect(order).toEqual([0, 1, 2, 3]) // still in submission order despite uneven sleeps
  })
})

describe('withCrossProcessFileLock', () => {
  it('serializes in-process callers and preserves every update', async () => {
    const p = path.join(tmpDir, 'xp-counter.txt')
    fs.writeFileSync(p, '0')
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withCrossProcessFileLock(p, async () => {
          const cur = Number(fs.readFileSync(p, 'utf-8'))
          await new Promise((r) => setTimeout(r, 1))
          await writeFileAtomic(p, String(cur + 1))
        })
      )
    )
    expect(Number(fs.readFileSync(p, 'utf-8'))).toBe(10)
  })

  it('removes the lockfile after the critical section (success)', async () => {
    const p = path.join(tmpDir, 'xp-clean.txt')
    await withCrossProcessFileLock(p, async () => {
      // lock is held here
      expect(fs.existsSync(`${p}.lock`)).toBe(true)
    })
    expect(fs.existsSync(`${p}.lock`)).toBe(false)
  })

  it('releases the lockfile even when fn throws', async () => {
    const p = path.join(tmpDir, 'xp-throw.txt')
    await expect(
      withCrossProcessFileLock(p, async () => { throw new Error('kaboom') })
    ).rejects.toThrow('kaboom')
    expect(fs.existsSync(`${p}.lock`)).toBe(false)
  })

  it('steals a stale lock left by a dead process', async () => {
    const p = path.join(tmpDir, 'xp-stale.txt')
    const lockPath = `${p}.lock`
    fs.writeFileSync(lockPath, '99999') // orphaned lock from a "crashed" pid
    const oldTime = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, oldTime, oldTime)

    let ran = false
    await withCrossProcessFileLock(p, async () => { ran = true }, { staleMs: 30_000 })
    expect(ran).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('on release, does NOT delete a lock another writer took over (owner-token guard)', async () => {
    // Models the P2 hazard: writer A stalls past staleMs, writer B steals the
    // lock (writing B's token), then A resumes. A's release must NOT delete B's
    // lock — otherwise a third writer could enter while B is mid-critical-section.
    const p = path.join(tmpDir, 'xp-owner-token.txt')
    const lockPath = `${p}.lock`
    let unblock: () => void = () => {}
    const blocked = new Promise<void>((r) => { unblock = r })

    const held = withCrossProcessFileLock(p, async () => {
      // While A holds the lock, simulate B stealing it and writing ITS token.
      fs.writeFileSync(lockPath, 'writer-B-token')
      await blocked
    })

    await new Promise((r) => setTimeout(r, 15)) // let A enter its critical section
    unblock()
    await held

    // A must have left B's lock untouched.
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('writer-B-token')
    fs.rmSync(lockPath, { force: true })
  })

  it('removes its OWN lock on release (token matches)', async () => {
    const p = path.join(tmpDir, 'xp-own-token.txt')
    await withCrossProcessFileLock(p, async () => {
      expect(fs.existsSync(`${p}.lock`)).toBe(true)
    })
    expect(fs.existsSync(`${p}.lock`)).toBe(false)
  })

  it('times out when a fresh lock is held by another (non-stale) holder', async () => {
    const p = path.join(tmpDir, 'xp-timeout.txt')
    const lockPath = `${p}.lock`
    fs.writeFileSync(lockPath, '12345') // fresh lock, mtime = now
    await expect(
      withCrossProcessFileLock(p, async () => undefined, {
        timeoutMs: 150,
        retryIntervalMs: 20,
        staleMs: 60_000,
      })
    ).rejects.toThrow(/Timed out/)
    // The other holder's lock is untouched.
    expect(fs.existsSync(lockPath)).toBe(true)
  })
})
