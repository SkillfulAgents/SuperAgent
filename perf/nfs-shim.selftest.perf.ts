/**
 * The shim's own coverage contract. Every access style the storage layer
 * could plausibly move to must land in the counts, or a regression that
 * switches API would go green. Runs in its own fork like every perf file.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { stat as statFromPromisesNamespace } from 'node:fs/promises'
import { disableNfsShim, enableNfsShim, nfsShimLatencyMs, nfsShimSnapshot, resetNfsShimCounters } from './nfs-shim'

describe('nfs-shim coverage', () => {
  const file = path.join(os.tmpdir(), `nfs-shim-selftest-${process.pid}.txt`)
  fs.writeFileSync(file, 'hello\n')

  afterEach(() => {
    disableNfsShim()
    resetNfsShimCounters()
  })

  it('counts and delays fs.promises calls', async () => {
    resetNfsShimCounters()
    enableNfsShim()
    const started = performance.now()
    await fs.promises.stat(file)
    const elapsed = performance.now() - started
    expect(nfsShimSnapshot().counts).toEqual({ stat: 1 })
    expect(elapsed).toBeGreaterThanOrEqual(nfsShimLatencyMs() - 1)
  })

  it('counts named imports from the fs/promises namespace', async () => {
    resetNfsShimCounters()
    enableNfsShim()
    await statFromPromisesNamespace(file)
    expect(nfsShimSnapshot().counts).toEqual({ stat: 1 })
  })

  it('counts FileHandle reads, including createReadStream on a handle', async () => {
    resetNfsShimCounters()
    enableNfsShim()
    const handle = await fs.promises.open(file, 'r')
    let streamed = 0
    try {
      for await (const chunk of handle.createReadStream()) streamed += (chunk as Buffer).length
    } finally {
      await handle.close()
    }
    const { counts, bytesRead } = nfsShimSnapshot()
    expect(streamed).toBe(6)
    expect(counts.open).toBe(1)
    expect(counts['handle.read']).toBeGreaterThanOrEqual(1)
    expect(bytesRead).toBe(6)
  })

  it('counts sync calls and path-based read streams (without delaying them)', async () => {
    resetNfsShimCounters()
    enableNfsShim()
    fs.statSync(file)
    fs.existsSync(file)
    fs.readFileSync(file)
    let streamed = 0
    for await (const chunk of fs.createReadStream(file)) streamed += (chunk as Buffer).length
    expect(streamed).toBe(6)
    const { counts } = nfsShimSnapshot()
    expect(counts['sync.statSync']).toBe(1)
    expect(counts['sync.existsSync']).toBe(1)
    expect(counts['sync.readFileSync']).toBe(1)
    expect(counts['sync.createReadStream']).toBe(1)
  })

  it('counts nothing while disabled', async () => {
    resetNfsShimCounters()
    await fs.promises.stat(file)
    fs.statSync(file)
    expect(nfsShimSnapshot()).toEqual({ counts: {}, totalOps: 0, bytesRead: 0 })
  })
})
