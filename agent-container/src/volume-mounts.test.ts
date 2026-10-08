import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { parseVolumes, rcloneMountArgs, untilMountAnswers, volumeAnswers, waitForUploads } from './volume-mounts'

describe('parseVolumes', () => {
  it('accepts names that are one path segment', () => {
    const raw = JSON.stringify([{ volumeId: 'v_17', name: 'team brain' }])
    expect(parseVolumes(raw)).toEqual([{ volumeId: 'v_17', name: 'team brain', cacheMode: 'local' }])
  })

  it('accepts a remote cache policy and rejects unknown modes', () => {
    expect(parseVolumes(JSON.stringify([{ volumeId: 'v1', name: 'cloud', cacheMode: 'remote' }]))).toEqual([
      { volumeId: 'v1', name: 'cloud', cacheMode: 'remote' },
    ])
    expect(parseVolumes(JSON.stringify([{ volumeId: 'v1', name: 'cloud', cacheMode: 'forever' }]))).toEqual([])
  })

  it.each(['..', 'a/b'])('rejects the whole list when a name is %j', (name) => {
    const raw = JSON.stringify([{ volumeId: 'v_1', name: 'ok' }, { volumeId: 'v_2', name }])
    expect(parseVolumes(raw)).toEqual([])
  })

  it.each(['', '..'])('rejects the whole list when a volumeId is %j', (volumeId) => {
    const raw = JSON.stringify([{ volumeId: 'v_1', name: 'ok' }, { volumeId, name: 'other' }])
    expect(parseVolumes(raw)).toEqual([])
  })
})

describe('rcloneMountArgs', () => {
  it("points rclone at the volume's address under the host API, and the driver settings", () => {
    const args = rcloneMountArgs('v_17', '/mounts/docs', 'http://host.docker.internal:47891/api')
    expect(args).toEqual([
      'mount2', ':webdav:', '/mounts/docs', '--webdav-url', 'http://host.docker.internal:47891/api/volumes/v_17',
      '--webdav-vendor', 'rclone',
      '--webdav-pacer-min-sleep', '1ms', '--low-level-retries', '13',
      '--vfs-cache-mode', 'writes', '--cache-dir', '/workspace/.volume-cache/v_17', '--vfs-handle-caching', '0', '--attr-timeout', '0s', '--vfs-write-back', '1s', '--dir-cache-time', '1s',
      '--file-perms', '0777',
      '--rc', '--rc-addr', 'unix:///tmp/rclone-v_17.sock', '--rc-no-auth',
    ])
  })
})

describe('remote mount cache policy', () => {
  it('preserves case-insensitive file identity independently of cache policy', () => {
    const mounts = parseVolumes(JSON.stringify([{ volumeId: 'dropbox', name: 'cloud', cacheMode: 'remote', caseInsensitive: true }]))
    expect(mounts[0]?.caseInsensitive).toBe(true)
    for (const mode of ['local', 'remote'] as const) {
      const args = rcloneMountArgs('v', '/mounts/docs', 'http://host/api', mode, true)
      expect(args[args.indexOf('--disable') + 1]).toBe('!CaseInsensitive')
      expect(args).not.toContain('--vfs-case-insensitive')
      expect(rcloneMountArgs('v', '/mounts/docs', 'http://host/api', mode)).not.toContain('--disable')
    }
  })
  it('caches directory listings and file reads while preserving the correctness settings', () => {
    const args = rcloneMountArgs('cloud', '/mounts/cloud', 'http://host/api', 'remote')
    const option = (name: string) => args[args.indexOf(name) + 1]
    expect(option('--dir-cache-time')).toBe('5m')
    expect(option('--vfs-cache-mode')).toBe('full')
    expect(option('--vfs-cache-max-size')).toBe('512M')
    expect(option('--vfs-cache-max-age')).toBe('1h')
    expect(option('--webdav-vendor')).toBe('rclone')
    expect(option('--vfs-handle-caching')).toBe('0')
    expect(option('--attr-timeout')).toBe('0s')
    expect(option('--vfs-write-back')).toBe('1s')
  })
})

describe('untilMountAnswers', () => {
  it('stops polling a path that never mounts once the attempt has settled, without asking the app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-'))
    let settled = false
    setTimeout(() => { settled = true }, 50)
    const answers = vi.fn(async () => {})
    await expect(untilMountAnswers(dir, fs.statSync(dir).dev, () => settled, answers)).resolves.toBeUndefined()
    expect(answers).not.toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('volumeAnswers', () => {
  it('asks the app for the volume root alone, with the mount token, and fails on any other answer', async () => {
    const requests: { method?: string; url?: string; headers: http.IncomingHttpHeaders }[] = []
    let status = 207
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers })
      res.writeHead(status).end('<d:multistatus xmlns:d="DAV:"/>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const hostApiUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api`
    try {
      await expect(volumeAnswers(hostApiUrl, 'v_17', 'secret')).resolves.toBeUndefined()
      expect(requests).toEqual([expect.objectContaining({ method: 'PROPFIND', url: '/api/volumes/v_17', headers: expect.objectContaining({ authorization: 'Bearer secret', depth: '0' }) })])
      status = 403
      await expect(volumeAnswers(hostApiUrl, 'v_17', 'secret')).rejects.toThrow('volume answered 403')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('waitForUploads', () => {
  afterEach(() => { vi.useRealTimers() })

  it('still waits just under the deadline, then returns what is still uploading', async () => {
    vi.useFakeTimers()
    let settled = false
    // 1_100 is off the 250ms poll grid, so the last poll lands up to one interval past it.
    const done = waitForUploads(async () => ['big.bin'], Date.now() + 1_100).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_099)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(151)
    await expect(done).resolves.toEqual(['big.bin'])
  })
})
