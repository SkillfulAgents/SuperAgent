import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyChromeProfileData } from './chrome-profile'

const ORIGINAL_PLATFORM = process.platform

describe('copyChromeProfileData', () => {
  let testHome: string
  let chromeDataDir: string
  let destination: string

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-chrome-profile-'))
    chromeDataDir = path.join(testHome, '.config', 'google-chrome')
    destination = path.join(testHome, 'destination')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.spyOn(os, 'homedir').mockReturnValue(testHome)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  function createProfile(profileId = 'Default', cookie = 'source-cookie'): string {
    const profileDir = path.join(chromeDataDir, profileId)
    fs.mkdirSync(path.join(profileDir, 'Local Storage', 'leveldb'), { recursive: true })
    fs.mkdirSync(path.join(profileDir, 'Session Storage'), { recursive: true })
    fs.mkdirSync(path.join(profileDir, 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(profileDir, 'Cookies'), cookie)
    fs.writeFileSync(path.join(profileDir, 'Login Data'), 'login-data')
    fs.writeFileSync(path.join(profileDir, 'Local Storage', 'leveldb', '000001.ldb'), 'local-data')
    fs.writeFileSync(path.join(profileDir, 'Session Storage', 'session'), 'session-data')
    fs.writeFileSync(path.join(profileDir, 'History'), 'must-not-copy')
    fs.writeFileSync(path.join(profileDir, 'Cache', 'cache-entry'), 'must-not-copy')
    return profileDir
  }

  it('copies only the selected session files and storage trees', async () => {
    createProfile()

    expect(await copyChromeProfileData('Default', destination)).toBe(true)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('source-cookie')
    expect(fs.readFileSync(path.join(destination, 'Login Data'), 'utf8')).toBe('login-data')
    expect(fs.readFileSync(path.join(destination, 'Local Storage', 'leveldb', '000001.ldb'), 'utf8'))
      .toBe('local-data')
    expect(fs.readFileSync(path.join(destination, 'Session Storage', 'session'), 'utf8'))
      .toBe('session-data')
    expect(fs.existsSync(path.join(destination, 'History'))).toBe(false)
    expect(fs.existsSync(path.join(destination, 'Cache'))).toBe(false)
  })

  it('returns false when the selected source profile does not exist', async () => {
    fs.mkdirSync(chromeDataDir, { recursive: true })

    expect(await copyChromeProfileData('Missing', destination)).toBe(false)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('refreshes data whose source changed since the previous sync', async () => {
    const profileDir = createProfile()
    await copyChromeProfileData('Default', destination)

    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'new-and-longer-source-cookie')
    await copyChromeProfileData('Default', destination)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8'))
      .toBe('new-and-longer-source-cookie')
  })

  it('re-seeds the destination when the selected source profile changes', async () => {
    createProfile('Default', 'default-cookie')
    createProfile('Profile 1', 'profile-one-cookie')
    await copyChromeProfileData('Default', destination)

    await copyChromeProfileData('Profile 1', destination)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('profile-one-cookie')
  })

  it('repairs a destination file that disappeared after a successful sync', async () => {
    createProfile()
    await copyChromeProfileData('Default', destination)
    fs.rmSync(path.join(destination, 'Login Data'))

    await copyChromeProfileData('Default', destination)

    expect(fs.readFileSync(path.join(destination, 'Login Data'), 'utf8')).toBe('login-data')
  })

  it('fails safe by re-seeding when the incremental-sync manifest is corrupt', async () => {
    createProfile()
    await copyChromeProfileData('Default', destination)
    fs.writeFileSync(path.join(destination, 'Cookies'), 'agent-session-cookie')
    fs.writeFileSync(path.join(destination, '.superagent-profile-sync.json'), '{not-json')

    await copyChromeProfileData('Default', destination)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('source-cookie')
    expect(() => JSON.parse(
      fs.readFileSync(path.join(destination, '.superagent-profile-sync.json'), 'utf8'),
    )).not.toThrow()
  })

  it('fails safe by re-seeding when the manifest is valid JSON of the wrong shape', async () => {
    createProfile()
    await copyChromeProfileData('Default', destination)
    fs.writeFileSync(path.join(destination, 'Cookies'), 'agent-session-cookie')
    fs.writeFileSync(
      path.join(destination, '.superagent-profile-sync.json'),
      JSON.stringify({ version: 2, files: 'nope' }),
    )

    await copyChromeProfileData('Default', destination)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('source-cookie')
  })

  it('tolerates a transient source file that vanishes between fingerprinting and copy', async () => {
    const profileDir = createProfile()
    fs.writeFileSync(path.join(profileDir, 'Cookies-journal'), 'hot-journal')

    const realCopyFile = fs.promises.copyFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, mode?) => {
      if (String(src).endsWith('Cookies-journal')) {
        fs.rmSync(path.join(profileDir, 'Cookies-journal'), { force: true })
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return realCopyFile(src, dest, mode)
    })

    expect(await copyChromeProfileData('Default', destination)).toBe(true)
    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('source-cookie')
    expect(fs.existsSync(path.join(destination, 'Cookies-journal'))).toBe(false)
  })

  it('refuses a profile id that escapes Chrome user-data storage', async () => {
    fs.mkdirSync(chromeDataDir, { recursive: true })
    fs.mkdirSync(path.join(chromeDataDir, '..', 'outside'), { recursive: true })
    fs.writeFileSync(path.join(chromeDataDir, '..', 'outside', 'Cookies'), 'outside-cookie')

    expect(await copyChromeProfileData('../outside', destination)).toBe(false)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('preserves agent-side profile changes when the source is unchanged', async () => {
    createProfile()
    await copyChromeProfileData('Default', destination)
    fs.writeFileSync(path.join(destination, 'Cookies'), 'agent-session-cookie')

    await copyChromeProfileData('Default', destination)

    expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('agent-session-cookie')
  })

  it('uses asynchronous filesystem work so profile copies do not block the host event loop', async () => {
    createProfile()

    const result = copyChromeProfileData('Default', destination)

    expect(result).toBeInstanceOf(Promise)
    await result
  })
})
