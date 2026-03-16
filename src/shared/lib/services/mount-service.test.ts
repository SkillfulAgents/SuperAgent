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

// Import after env is set up (uses SUPERAGENT_DATA_DIR)
async function importService() {
  const mod = await import('./mount-service')
  return mod
}

describe('mount-service', () => {
  describe('getMounts', () => {
    it('returns empty array when no mounts.json exists', async () => {
      const { getMounts } = await importService()
      expect(getMounts('test-agent')).toEqual([])
    })
  })

  describe('addMount', () => {
    it('creates mounts.json and returns mount with correct fields', async () => {
      const { addMount } = await importService()
      const hostPath = makeHostDir('myapp')
      const mount = addMount('test-agent', hostPath)

      expect(mount.id).toBeDefined()
      expect(mount.hostPath).toBe(hostPath)
      expect(mount.containerPath).toBe('/mounts/myapp')
      expect(mount.folderName).toBe('myapp')
      expect(mount.addedAt).toBeDefined()
      expect(new Date(mount.addedAt).getTime()).not.toBeNaN()
    })

    it('picks /mounts/{basename} as containerPath', async () => {
      const { addMount } = await importService()
      const hostPath = makeHostDir('src')
      const mount = addMount('test-agent', hostPath)
      expect(mount.containerPath).toBe('/mounts/src')
    })

    it('appends -2, -3 on container path collision', async () => {
      const { addMount } = await importService()
      const dir1 = makeHostDir('a/project')
      const dir2 = makeHostDir('b/project')
      const dir3 = makeHostDir('c/project')
      const m1 = addMount('test-agent', dir1)
      const m2 = addMount('test-agent', dir2)
      const m3 = addMount('test-agent', dir3)

      expect(m1.containerPath).toBe('/mounts/project')
      expect(m2.containerPath).toBe('/mounts/project-2')
      expect(m3.containerPath).toBe('/mounts/project-3')
    })

    it('persists mounts to disk', async () => {
      const { addMount, getMounts } = await importService()
      addMount('test-agent', makeHostDir('folder-a'))
      addMount('test-agent', makeHostDir('folder-b'))

      const mounts = getMounts('test-agent')
      expect(mounts).toHaveLength(2)
      expect(mounts[0].folderName).toBe('folder-a')
      expect(mounts[1].folderName).toBe('folder-b')
    })

    it('rejects relative paths', async () => {
      const { addMount } = await importService()
      expect(() => addMount('test-agent', 'relative/path')).toThrow('absolute path')
    })

    it('rejects non-existent paths', async () => {
      const { addMount } = await importService()
      expect(() => addMount('test-agent', '/non/existent/path/xyz')).toThrow()
    })

    it('rejects files (non-directories)', async () => {
      const { addMount } = await importService()
      const filePath = path.join(tmpDir, 'a-file.txt')
      fs.writeFileSync(filePath, 'content')
      expect(() => addMount('test-agent', filePath)).toThrow('directory')
    })

    it('resolves symlinks', async () => {
      const { addMount } = await importService()
      const realDir = makeHostDir('real-dir')
      const linkPath = path.join(tmpDir, 'host-dirs', 'link-dir')
      fs.symlinkSync(realDir, linkPath)

      const mount = addMount('test-agent', linkPath)
      // hostPath should be the resolved real path (use realpathSync for comparison
      // since macOS /tmp -> /private/var/... resolution)
      expect(mount.hostPath).toBe(fs.realpathSync(realDir))
    })
  })

  describe('removeMount', () => {
    it('removes entry by id, preserving others', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      const m1 = addMount('test-agent', makeHostDir('keep'))
      const m2 = addMount('test-agent', makeHostDir('remove'))

      removeMount('test-agent', m2.id)

      const mounts = getMounts('test-agent')
      expect(mounts).toHaveLength(1)
      expect(mounts[0].id).toBe(m1.id)
    })

    it('is a no-op for non-existent mount id', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      addMount('test-agent', makeHostDir('keep'))

      removeMount('test-agent', 'non-existent-id')

      expect(getMounts('test-agent')).toHaveLength(1)
    })
  })

  describe('getMountsWithHealth', () => {
    it('returns ok for existing host paths', async () => {
      const { addMount, getMountsWithHealth } = await importService()
      addMount('test-agent', makeHostDir('exists'))

      const mounts = getMountsWithHealth('test-agent')
      expect(mounts).toHaveLength(1)
      expect(mounts[0].health).toBe('ok')
    })

    it('returns missing when host path is later deleted', async () => {
      const { addMount, getMountsWithHealth } = await importService()
      const dir = makeHostDir('will-delete')
      addMount('test-agent', dir)

      // Delete the directory after adding mount
      fs.rmSync(dir, { recursive: true })

      const mounts = getMountsWithHealth('test-agent')
      expect(mounts).toHaveLength(1)
      expect(mounts[0].health).toBe('missing')
    })
  })

  describe('CRUD roundtrip', () => {
    it('add/remove cycles produce consistent state', async () => {
      const { addMount, removeMount, getMounts } = await importService()
      const m1 = addMount('test-agent', makeHostDir('a'))
      const m2 = addMount('test-agent', makeHostDir('b'))
      const m3 = addMount('test-agent', makeHostDir('c'))

      removeMount('test-agent', m2.id)
      expect(getMounts('test-agent')).toHaveLength(2)

      removeMount('test-agent', m1.id)
      expect(getMounts('test-agent')).toHaveLength(1)
      expect(getMounts('test-agent')[0].id).toBe(m3.id)

      removeMount('test-agent', m3.id)
      expect(getMounts('test-agent')).toHaveLength(0)
    })
  })
})
