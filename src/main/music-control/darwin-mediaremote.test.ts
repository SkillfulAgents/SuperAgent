import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DarwinMediaRemoteBackend, PERL, findMediaRemoteAdapter, playerNameFromBundleId } from './darwin-mediaremote'

const adapter = { script: '/res/mediaremote-adapter.pl', framework: '/res/MediaRemoteAdapter.framework' }

describe('DarwinMediaRemoteBackend', () => {
  it('asks the adapter through Apple\'s perl and reports the playing app', async () => {
    const run = vi.fn(async () => JSON.stringify({ bundleIdentifier: 'com.spotify.client', playing: true, title: 'Song' }))
    const backend = new DarwinMediaRemoteBackend(adapter, run)
    await expect(backend.probe()).resolves.toEqual({ id: 'com.spotify.client', name: 'Spotify' })
    expect(run).toHaveBeenCalledWith(PERL, [adapter.script, adapter.framework, 'get', '--no-artwork'])
  })

  it('names a browser by its parent app, not its helper process', async () => {
    const run = vi.fn(async () => JSON.stringify({
      bundleIdentifier: 'com.google.Chrome.helper', parentApplicationBundleIdentifier: 'com.google.Chrome', playing: true, title: 'Video',
    }))
    await expect(new DarwinMediaRemoteBackend(adapter, run).probe()).resolves.toEqual({ id: 'com.google.Chrome', name: 'Chrome' })
  })

  it('reports nothing when the now-playing app is paused, or when there is none', async () => {
    const paused = vi.fn(async () => JSON.stringify({ bundleIdentifier: 'com.apple.Music', playing: false, title: 'Song' }))
    await expect(new DarwinMediaRemoteBackend(adapter, paused).probe()).resolves.toBeNull()
    const none = vi.fn(async () => 'null\n')
    await expect(new DarwinMediaRemoteBackend(adapter, none).probe()).resolves.toBeNull()
    const empty = vi.fn(async () => '')
    await expect(new DarwinMediaRemoteBackend(adapter, empty).probe()).resolves.toBeNull()
  })

  it('rejects output that is not what the adapter promises', async () => {
    const run = vi.fn(async () => JSON.stringify({ playing: true }))
    await expect(new DarwinMediaRemoteBackend(adapter, run).probe()).rejects.toThrow()
    const garbage = vi.fn(async () => 'Segmentation fault')
    await expect(new DarwinMediaRemoteBackend(adapter, garbage).probe()).rejects.toThrow(/other than JSON/)
  })

  it('sends the MediaRemote pause command', async () => {
    const run = vi.fn(async () => '')
    await new DarwinMediaRemoteBackend(adapter, run).pause('com.spotify.client')
    expect(run).toHaveBeenLastCalledWith(PERL, [adapter.script, adapter.framework, 'send', '1'])
  })

  it('plays only the held player, which still owns now playing while paused', async () => {
    const owner = (info: object | null) => vi.fn(async (_file: string, args: string[]) => args.includes('get') ? JSON.stringify(info) : '')
    const paused = owner({ bundleIdentifier: 'com.spotify.client', playing: false, title: 'Song' })
    await expect(new DarwinMediaRemoteBackend(adapter, paused).play('com.spotify.client')).resolves.toBe(true)
    expect(paused).toHaveBeenLastCalledWith(PERL, [adapter.script, adapter.framework, 'send', '0'])

    // The person played and paused a browser video since: play would start it.
    const browser = owner({ bundleIdentifier: 'com.google.Chrome.helper', parentApplicationBundleIdentifier: 'com.google.Chrome', playing: false, title: 'Video' })
    await expect(new DarwinMediaRemoteBackend(adapter, browser).play('com.spotify.client')).resolves.toBe(false)
    expect(browser).not.toHaveBeenCalledWith(PERL, expect.arrayContaining(['send']))

    const gone = owner(null)
    await expect(new DarwinMediaRemoteBackend(adapter, gone).play('com.spotify.client')).resolves.toBe(false)
    expect(gone).toHaveBeenCalledTimes(1)

    // Reported as still playing a moment after a pause (the state trails commands): play anyway.
    const stale = owner({ bundleIdentifier: 'com.spotify.client', playing: true, title: 'Song' })
    await expect(new DarwinMediaRemoteBackend(adapter, stale).play('com.spotify.client')).resolves.toBe(true)
    expect(stale).toHaveBeenLastCalledWith(PERL, [adapter.script, adapter.framework, 'send', '0'])
  })
})

describe('playerNameFromBundleId', () => {
  it('knows the common players and falls back to the last segment', () => {
    expect(playerNameFromBundleId('com.spotify.client')).toBe('Spotify')
    expect(playerNameFromBundleId('com.apple.Music')).toBe('Music')
    expect(playerNameFromBundleId('io.example.plexamp')).toBe('Plexamp')
    expect(playerNameFromBundleId('nodots')).toBe('Nodots')
  })
})

describe('findMediaRemoteAdapter', () => {
  it('needs both the script and the framework', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaremote-'))
    try {
      expect(findMediaRemoteAdapter(dir)).toBeNull()
      fs.writeFileSync(path.join(dir, 'mediaremote-adapter.pl'), '')
      expect(findMediaRemoteAdapter(dir)).toBeNull()
      fs.mkdirSync(path.join(dir, 'MediaRemoteAdapter.framework'))
      expect(findMediaRemoteAdapter(dir)).toEqual({
        script: path.join(dir, 'mediaremote-adapter.pl'),
        framework: path.join(dir, 'MediaRemoteAdapter.framework'),
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
