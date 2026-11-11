import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents } from '../schema'
import { removeChromeProfileImportCopies } from './0011-remove-chrome-profile-import-copies'

let handle: TestDatabase
let dataDir: string

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'chrome-profile-import-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function write(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), content)
  }
}

async function addAgent(slug: string, browserProfile: Record<string, string>): Promise<string> {
  await handle.db.insert(agents).values({ slug, name: slug, createdAt: new Date(), runtime: 'local', workspaceHandle: null }).run()
  const root = path.join(dataDir, 'agents', slug, 'workspace', '.browser-profile')
  fs.mkdirSync(root, { recursive: true })
  write(root, browserProfile)
  return root
}

/** Every file under `root`, as posix paths relative to it. */
function filesUnder(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

// What the built-in browser keeps in its user-data-dir: its own profile under Default/.
const BROWSER_OWN = {
  'Default/Cookies': 'agent-cookies',
  'Default/Local Storage/leveldb/000003.log': 'agent-storage',
  'Default/Preferences': '{}',
  'Local State': '{}',
}

// What the import copied to the root of the user-data-dir.
const IMPORTED = {
  'Cookies': 'user-cookies',
  'Cookies-journal': '',
  'Login Data': 'user-passwords',
  'Login Data-journal': '',
  'Web Data': 'user-autofill',
  'Web Data-journal': '',
  'Local Storage/leveldb/000001.ldb': 'user-storage',
  'Session Storage/000002.log': 'user-session',
  '.superagent-profile-sync.json': '{"version":1,"profileId":"Default","files":{}}',
}

describe('remove-chrome-profile-import-copies', () => {
  it('deletes the copies at the root of the built-in browser profile and keeps the browser’s own profile', async () => {
    const imported = await addAgent('imported', { ...BROWSER_OWN, ...IMPORTED })
    const clean = await addAgent('clean', BROWSER_OWN)

    expect(await removeChromeProfileImportCopies(handle.db)).toEqual(['imported'])

    expect(filesUnder(imported)).toEqual(Object.keys(BROWSER_OWN).sort())
    expect(fs.readFileSync(path.join(imported, 'Default/Cookies'), 'utf8')).toBe('agent-cookies')
    expect(fs.existsSync(path.join(imported, 'Local Storage'))).toBe(false)
    expect(filesUnder(clean)).toEqual(Object.keys(BROWSER_OWN).sort())
  })

  it('keeps each host browser profile and removes only the sync manifest beside it', async () => {
    const hostProfile = path.join(dataDir, 'host-browser-profiles', 'imported', 'Default')
    write(hostProfile, { 'Cookies': 'agent-and-user-cookies', 'Login Data': 'passwords', '.superagent-profile-sync.json': '{}' })
    write(path.join(dataDir, 'host-browser-profiles', 'fresh', 'Default'), { 'Cookies': 'agent-cookies' })

    await removeChromeProfileImportCopies(handle.db)

    expect(filesUnder(hostProfile)).toEqual(['Cookies', 'Login Data'])
    expect(filesUnder(path.join(dataDir, 'host-browser-profiles', 'fresh'))).toEqual(['Default/Cookies'])
  })

  it('finds nothing on a second run, nor on an install that never had an agent or a host browser', async () => {
    expect(await removeChromeProfileImportCopies(handle.db)).toEqual([])

    await addAgent('imported', IMPORTED)
    await addAgent('no-profile', {})
    fs.rmSync(path.join(dataDir, 'agents', 'no-profile', 'workspace', '.browser-profile'), { recursive: true })

    expect(await removeChromeProfileImportCopies(handle.db)).toEqual(['imported'])
    expect(await removeChromeProfileImportCopies(handle.db)).toEqual([])
  })
})
