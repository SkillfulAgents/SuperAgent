import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { removeInstalledUpdateDownload, versionInUpdateFileName } from './update-download-cache'

describe('versionInUpdateFileName', () => {
  it.each([
    ['Gamut-0.5.49-arm64.zip', '0.5.49'],
    ['Gamut-0.5.49-rc.3-arm64.zip', '0.5.49-rc.3'],
    ['Gamut-1.0.0-x64.zip', '1.0.0'],
  ])('reads %s as %s', (fileName, version) => {
    expect(versionInUpdateFileName(fileName)).toBe(version)
  })

  it.each(['Gamut-arm64.zip', 'Gamut-0.5-arm64.zip', 'Gamut-0.5.49-arm64.dmg', 'update.zip', 'Gamut Setup 0.5.49.exe'])(
    'reads no version from %s',
    (fileName) => {
      expect(versionInUpdateFileName(fileName)).toBeNull()
    },
  )
})

describe('removeInstalledUpdateDownload', () => {
  let cacheDir: string
  let pendingDir: string

  // The layout electron-updater leaves after it downloads `fileName`.
  function downloaded(fileName: string, info: unknown = { fileName, sha512: 'x', isAdminRightsRequired: false }) {
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, fileName), 'zip')
    fs.writeFileSync(path.join(pendingDir, 'current.blockmap'), 'map')
    fs.writeFileSync(path.join(pendingDir, 'update-info.json'), typeof info === 'string' ? info : JSON.stringify(info))
    fs.writeFileSync(path.join(cacheDir, 'update.zip'), 'zip')
    fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), 'map')
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cache-'))
    pendingDir = path.join(cacheDir, 'pending')
  })

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it('removes the download of the version that is running', async () => {
    downloaded('Gamut-0.5.49-arm64.zip')
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(true)
    expect(fs.existsSync(pendingDir)).toBe(false)
  })

  it('removes the download of an older version', async () => {
    downloaded('Gamut-0.5.49-rc.3-arm64.zip')
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(true)
    expect(fs.existsSync(pendingDir)).toBe(false)
  })

  it('keeps the base of the next partial download', async () => {
    downloaded('Gamut-0.5.49-arm64.zip')
    await removeInstalledUpdateDownload(pendingDir, '0.5.49')
    expect(fs.readdirSync(cacheDir).sort()).toEqual(['current.blockmap', 'update.zip'])
  })

  it.each([
    ['a newer release', 'Gamut-0.5.50-arm64.zip'],
    ['a newer release candidate', 'Gamut-0.5.50-rc.1-arm64.zip'],
  ])('keeps a downloaded update that is not installed yet: %s', async (_, fileName) => {
    downloaded(fileName)
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, fileName))).toBe(true)
  })

  it('keeps a release a release candidate leads to', async () => {
    downloaded('Gamut-0.5.49-arm64.zip')
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49-rc.3')).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, 'Gamut-0.5.49-arm64.zip'))).toBe(true)
  })

  it('does nothing when nothing was downloaded', async () => {
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(false)
  })

  it.each([
    ['unreadable', '{not json'],
    ['without a file name', { sha512: 'x' }],
  ])('keeps everything when the record is %s', async (_, info) => {
    downloaded('Gamut-0.5.49-arm64.zip', info)
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, 'Gamut-0.5.49-arm64.zip'))).toBe(true)
  })

  it('keeps a download whose name has no version', async () => {
    downloaded('latest.zip')
    expect(await removeInstalledUpdateDownload(pendingDir, '0.5.49')).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, 'latest.zip'))).toBe(true)
  })

  it('keeps everything when the running version is not a version', async () => {
    downloaded('Gamut-0.5.49-arm64.zip')
    expect(await removeInstalledUpdateDownload(pendingDir, 'dev')).toBe(false)
  })
})
