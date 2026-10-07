import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

beforeEach(() => {
  // Use realpathSync to resolve macOS /tmp -> /private/var symlink
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-service-test-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

/** Create a real temp directory to use as a mount host path */
function makeHostDir(name: string): string {
  const dir = path.join(tmpDir, 'host-dirs', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Write mounts.json for test-agent as given, bypassing addMount */
function writeRows(rows: unknown[]) {
  const file = path.join(tmpDir, 'agents', 'test-agent', 'mounts.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rows))
  return file
}

// Import after env is set up (uses SUPERAGENT_DATA_DIR)
async function importService() {
  const mod = await import('./mount-service')
  return mod
}

describe('mount-service', () => {
  describe('getMounts', () => {
    it('returns empty array when no mounts.json exists', async () => {
      const { getMounts } = await importService()
      expect(await getMounts('test-agent')).toEqual([])
    })
  })

  describe('addMount', () => {
    it('creates mounts.json and returns a local volume named by the folder', async () => {
      const { addMount } = await importService()
      const hostPath = makeHostDir('myapp')
      const mount = await addMount('test-agent', 'local', { path: hostPath })

      expect(mount).toEqual({ id: expect.any(String), name: 'myapp', type: 'local', config: { path: hostPath } })
    })

    it('appends -2, -3 on name collision', async () => {
      const { addMount } = await importService()
      const dir1 = makeHostDir('a/project')
      const dir2 = makeHostDir('b/project')
      const dir3 = makeHostDir('c/project')
      const m1 = await addMount('test-agent', 'local', { path: dir1 })
      const m2 = await addMount('test-agent', 'local', { path: dir2 })
      const m3 = await addMount('test-agent', 'local', { path: dir3 })

      expect([m1.name, m2.name, m3.name]).toEqual(['project', 'project-2', 'project-3'])
    })

    it('persists mounts to disk', async () => {
      const { addMount, getMounts } = await importService()
      await addMount('test-agent', 'local', { path: makeHostDir('folder-a') })
      await addMount('test-agent', 'local', { path: makeHostDir('folder-b') })

      const mounts = await getMounts('test-agent')
      expect(mounts).toHaveLength(2)
      expect(mounts.map((m) => m.name)).toEqual(['folder-a', 'folder-b'])
    })

    it('rejects relative paths', async () => {
      const { addMount } = await importService()
      await expect(addMount('test-agent', 'local', { path: 'relative/path' })).rejects.toThrow('absolute path')
    })

    it('rejects non-existent paths', async () => {
      const { addMount } = await importService()
      await expect(addMount('test-agent', 'local', { path: '/non/existent/path/xyz' })).rejects.toThrow()
    })

    it('rejects files (non-directories)', async () => {
      const { addMount } = await importService()
      const filePath = path.join(tmpDir, 'a-file.txt')
      fs.writeFileSync(filePath, 'content')
      await expect(addMount('test-agent', 'local', { path: filePath })).rejects.toThrow('directory')
    })

    it('resolves symlinks', async () => {
      const { addMount } = await importService()
      const realDir = makeHostDir('real-dir')
      const linkPath = path.join(tmpDir, 'host-dirs', 'link-dir')
      fs.symlinkSync(realDir, linkPath)

      const mount = await addMount('test-agent', 'local', { path: linkPath })
      // hostPath should be the resolved real path (use realpathSync for comparison
      // since macOS /tmp -> /private/var/... resolution)
      expect(mount.config).toEqual({ path: fs.realpathSync(realDir) })
    })

    it('keeps a folder whose name is only spaces, as the image accepts it', async () => {
      const { addMount, listVolumes } = await importService()
      const dir = makeHostDir('   ')
      const mount = await addMount('test-agent', 'local', { path: dir })
      expect((await listVolumes('test-agent')).volumes).toEqual([{ volumeId: mount.id, name: '   ' }])
    })

    // The name becomes /mounts/<name>, and the filesystem root has none.
    it('rejects a folder with no name', async () => {
      const { addMount } = await importService()
      await expect(addMount('test-agent', 'local', { path: path.parse(tmpDir).root })).rejects.toThrow('The folder must have a name')
    })
  })

  describe('addMount by type', () => {
    it('adds only a type it knows, with a config that type accepts, and answers with no config', async () => {
      const { addMount, volumeSummary } = await importService()
      await expect(addMount('test-agent', 'gdrive', {})).rejects.toThrow('Unknown volume type')
      await expect(addMount('test-agent', 'toString', {})).rejects.toThrow('Unknown volume type')
      await expect(addMount('test-agent', 'local', { folder: makeHostDir('x') })).rejects.toThrow('Invalid volume config')

      const mount = await addMount('test-agent', 'local', { path: makeHostDir('y') })
      expect(volumeSummary(mount)).toEqual({ id: mount.id, name: 'y', type: 'local', hostPath: makeHostDir('y') })
    })
  })

  describe('removeMount', () => {
    it('removes entry by id, preserving others', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      const m1 = await addMount('test-agent', 'local', { path: makeHostDir('keep') })
      const m2 = await addMount('test-agent', 'local', { path: makeHostDir('remove') })

      await removeMount('test-agent', m2.id)

      const mounts = await getMounts('test-agent')
      expect(mounts).toHaveLength(1)
      expect(mounts[0].id).toBe(m1.id)
    })

    it('is a no-op for non-existent mount id', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      await addMount('test-agent', 'local', { path: makeHostDir('keep') })

      await removeMount('test-agent', 'non-existent-id')

      expect(await getMounts('test-agent')).toHaveLength(1)
    })
  })

  describe('getMountsWithHealth', () => {
    it('returns ok for existing host paths', async () => {
      const { addMount, getMountsWithHealth } = await importService()
      const dir = makeHostDir('exists')
      await addMount('test-agent', 'local', { path: dir })

      const mounts = await getMountsWithHealth('test-agent')
      expect(mounts).toEqual([{ id: expect.any(String), name: 'exists', type: 'local', health: 'ok', hostPath: dir }])
    })

    it('returns missing when the folder is replaced by a link', async () => {
      const { addMount, getMountsWithHealth } = await importService()
      const dir = makeHostDir('replaced')
      await addMount('test-agent', 'local', { path: dir })
      fs.renameSync(dir, `${dir}-real`)
      fs.symlinkSync(`${dir}-real`, dir)

      expect((await getMountsWithHealth('test-agent'))[0].health).toBe('missing')
    })

    it('returns missing when host path is later deleted', async () => {
      const { addMount, getMountsWithHealth } = await importService()
      const dir = makeHostDir('will-delete')
      await addMount('test-agent', 'local', { path: dir })

      // Delete the directory after adding mount
      fs.rmSync(dir, { recursive: true })

      const mounts = await getMountsWithHealth('test-agent')
      expect(mounts).toHaveLength(1)
      expect(mounts[0].health).toBe('missing')
    })
  })

  describe('listVolumes', () => {
    it('sends a volume whose source serves its root, leaves out the rest with why, and the card agrees', async () => {
      const { listVolumes, getMountsWithHealth } = await importService()
      const notes = makeHostDir('notes')
      const gone = makeHostDir('old-drive')
      fs.rmSync(gone, { recursive: true })
      writeRows([
        { id: 'v1', name: 'notes', type: 'local', config: { path: notes } },
        { id: 'v2', name: 'old-drive', type: 'local', config: { path: gone } },
        { id: 'v3', name: 'bad', type: 'local', config: { folder: notes } },
        // A row from before volumes, for a folder at the filesystem root: its name is ''.
        { id: 'v4', hostPath: notes, containerPath: '/mounts/' },
      ])

      expect(await listVolumes('test-agent')).toEqual({
        volumes: [{ volumeId: 'v1', name: 'notes' }],
        notMounted: [{ name: 'old-drive', reason: 'not found' }, { name: 'bad', reason: 'unreadable' }, { name: '', reason: 'invalid name' }],
      })
      expect((await getMountsWithHealth('test-agent')).map((m) => m.health)).toEqual(['ok', 'missing', 'missing', 'missing'])
    })

    // Root ignores mode bits, so this needs an ordinary user.
    it.skipIf(process.getuid?.() === 0)('reports a folder the app may not reach as not accessible', async () => {
      const { listVolumes } = await importService()
      const parent = makeHostDir('locked')
      const inner = path.join(parent, 'inner')
      fs.mkdirSync(inner)
      writeRows([{ id: 'v1', name: 'inner', type: 'local', config: { path: inner } }])
      fs.chmodSync(parent, 0)
      try {
        expect((await listVolumes('test-agent')).notMounted).toEqual([{ name: 'inner', reason: 'not accessible' }])
      } finally {
        fs.chmodSync(parent, 0o755)
      }
    })
  })

  describe('stored rows', () => {
    it('reads a row from before volumes had a type as a local folder named by its container path, and saves the new shape on the next write', async () => {
      const { addMount, getMounts } = await importService()
      const hostPath = makeHostDir('notes')
      const file = writeRows([{ id: 'old', hostPath, containerPath: '/mounts/notes-2', folderName: 'notes', addedAt: '2026-01-01T00:00:00.000Z' }])
      const old = { id: 'old', name: 'notes-2', type: 'local', config: { path: hostPath } }

      expect(await getMounts('test-agent')).toEqual([old])
      await addMount('test-agent', 'local', { path: makeHostDir('more') })
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))[0]).toEqual(old)
    })

    it('skips a row of a type this version does not know, keeps it and its name on the next write, and removes it by id', async () => {
      const { addMount, getMountsWithHealth, removeMount } = await importService()
      const unknown = { id: 'drive', name: 'notes', type: 'not-a-type', config: { folderId: 'x' } }
      const file = writeRows([unknown])

      expect(await getMountsWithHealth('test-agent')).toEqual([])
      expect((await addMount('test-agent', 'local', { path: makeHostDir('notes') })).name).toBe('notes-2')
      const rows = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(rows[0]).toEqual(unknown)
      expect(rows).toHaveLength(2)
      const added = JSON.parse(fs.readFileSync(file, 'utf-8'))[1].id
      await removeMount('test-agent', added)
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([unknown])
      await removeMount('test-agent', 'drive')
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([])
    })

    it('lists a row of a known type whose config is not that type\'s as missing, and still removes it', async () => {
      const { getMountsWithHealth, removeMount, getMounts } = await importService()
      writeRows([{ id: 'bad', name: 'bad', type: 'local', config: { folder: '/x' } }])

      expect((await getMountsWithHealth('test-agent')).map(({ health, hostPath }) => ({ health, hostPath }))).toEqual([{ health: 'missing', hostPath: null }])
      await removeMount('test-agent', 'bad')
      expect(await getMounts('test-agent')).toEqual([])
    })
  })

  describe('resolveVolume', () => {
    it("resolves an agent's own volume, and nothing for another agent's or an unknown id", async () => {
      const { addMount, resolveVolume } = await importService()
      const folder = makeHostDir('notes')
      fs.writeFileSync(path.join(folder, 'a.txt'), 'a')
      const mount = await addMount('agent-a', 'local', { path: folder })

      const volume = await resolveVolume('agent-a', mount.id)
      if (!volume) throw new Error('expected the volume to resolve')
      expect((await volume.list('')).map((entry) => entry.name)).toEqual(['a.txt'])
      expect(await resolveVolume('agent-b', mount.id)).toBeNull()
      expect(await resolveVolume('agent-a', 'unknown')).toBeNull()
    })
  })

  describe('CRUD roundtrip', () => {
    it('add/remove cycles produce consistent state', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      const m1 = await addMount('test-agent', 'local', { path: makeHostDir('a') })
      const m2 = await addMount('test-agent', 'local', { path: makeHostDir('b') })
      const m3 = await addMount('test-agent', 'local', { path: makeHostDir('c') })

      await removeMount('test-agent', m2.id)
      expect(await getMounts('test-agent')).toHaveLength(2)

      await removeMount('test-agent', m1.id)
      expect(await getMounts('test-agent')).toHaveLength(1)
      expect((await getMounts('test-agent'))[0].id).toBe(m3.id)

      await removeMount('test-agent', m3.id)
      expect(await getMounts('test-agent')).toHaveLength(0)
    })
  })
})
