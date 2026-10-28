import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  deleteArtifactFromFilesystem,
  listArtifactsFromFilesystem,
  renameArtifactOnFilesystem,
} from './artifact-service'

describe('artifact-service', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'artifact-service-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function createArtifactDir(
    agentSlug: string,
    artifactSlug: string,
    pkg: Record<string, unknown>
  ) {
    const dir = path.join(
      testDir,
      'agents',
      agentSlug,
      'workspace',
      'artifacts',
      artifactSlug
    )
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(pkg)
    )
    fs.mkdirSync(path.join(dir, 'node_modules'))
    return dir
  }

  describe('listArtifactsFromFilesystem', () => {
    it('never has more than ten filesystem probes in flight, even with rejected groups', async () => {
      // 30 artifacts × 3 probes each, a third of them without package.json —
      // an artifact that gives up early frees its slot, which would let sibling
      // probes exceed the bound if the limiter wrapped artifacts.
      for (let i = 0; i < 30; i++) {
        const slug = `art-${String(i).padStart(2, '0')}`
        if (i % 3 === 0) {
          fs.mkdirSync(path.join(testDir, 'agents', 'test-agent', 'workspace', 'artifacts', slug), { recursive: true })
        } else {
          createArtifactDir('test-agent', slug, { name: slug })
        }
      }

      let inFlight = 0
      let maxInFlight = 0
      const track = async <T>(run: () => Promise<T>): Promise<T> => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          // Yield so concurrent probes overlap instead of completing in turn.
          await new Promise((resolve) => setTimeout(resolve, 1))
          return await run()
        } finally {
          inFlight -= 1
        }
      }
      // The manifest read and the two existence checks; the actor's own
      // containment lookups around each are not what the bound is about.
      const realReadFile = fs.promises.readFile
      const realStat = fs.promises.stat
      vi.spyOn(fs.promises, 'readFile').mockImplementation(((...args: Parameters<typeof realReadFile>) =>
        track(() => realReadFile(...args))) as typeof fs.promises.readFile)
      vi.spyOn(fs.promises, 'stat').mockImplementation(((...args: Parameters<typeof realStat>) =>
        track(() => realStat(...args))) as typeof fs.promises.stat)

      try {
        const result = await listArtifactsFromFilesystem('test-agent')
        expect(result.map((a) => a.slug)).toHaveLength(20)
        expect(maxInFlight).toBeLessThanOrEqual(10)
        expect(maxInFlight).toBeGreaterThan(1)
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('returns empty array when artifacts dir does not exist', async () => {
      // Agent dir exists but no artifacts subdirectory
      const agentDir = path.join(testDir, 'agents', 'test-agent', 'workspace')
      fs.mkdirSync(agentDir, { recursive: true })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toEqual([])
    })

    it('returns empty array when agent does not exist', async () => {
      const result = await listArtifactsFromFilesystem('nonexistent-agent')
      expect(result).toEqual([])
    })

    it('returns empty array when artifacts dir is empty', async () => {
      const artifactsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        'artifacts'
      )
      fs.mkdirSync(artifactsDir, { recursive: true })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toEqual([])
    })

    it('reads dashboard metadata from package.json', async () => {
      createArtifactDir('test-agent', 'sales-dashboard', {
        name: 'Sales Dashboard',
        description: 'Monthly sales overview',
        scripts: { start: 'bun run index.js' },
      })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toEqual([
        {
          slug: 'sales-dashboard',
          name: 'Sales Dashboard',
          description: 'Monthly sales overview',
          status: 'stopped',
          port: 0,
        },
      ])
    })

    it('lists multiple dashboards', async () => {
      createArtifactDir('test-agent', 'dashboard-a', {
        name: 'Dashboard A',
        description: 'First dashboard',
      })
      createArtifactDir('test-agent', 'dashboard-b', {
        name: 'Dashboard B',
        description: 'Second dashboard',
      })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(2)
      expect(result.map((d) => d.slug).sort()).toEqual([
        'dashboard-a',
        'dashboard-b',
      ])
    })

    it('uses slug as name when package.json has no name field', async () => {
      createArtifactDir('test-agent', 'unnamed-dash', {
        description: 'Has description but no name',
      })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('unnamed-dash')
      expect(result[0].description).toBe('Has description but no name')
    })

    it('defaults description to empty string when missing', async () => {
      createArtifactDir('test-agent', 'no-desc', {
        name: 'No Description Dashboard',
      })

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].description).toBe('')
    })

    it('skips directories without package.json', async () => {
      // Create a dir with package.json
      createArtifactDir('test-agent', 'valid-dash', {
        name: 'Valid',
        description: 'Has package.json',
      })

      // Create a dir without package.json
      const noPackageDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        'artifacts',
        'no-package'
      )
      fs.mkdirSync(noPackageDir, { recursive: true })
      fs.writeFileSync(path.join(noPackageDir, 'index.js'), 'console.log("hi")')

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].slug).toBe('valid-dash')
    })

    it('skips directories with invalid JSON in package.json', async () => {
      createArtifactDir('test-agent', 'valid-dash', {
        name: 'Valid',
        description: 'Good JSON',
      })

      // Create dir with invalid JSON
      const badDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        'artifacts',
        'bad-json'
      )
      fs.mkdirSync(badDir, { recursive: true })
      fs.writeFileSync(path.join(badDir, 'package.json'), 'not valid json {{{')

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].slug).toBe('valid-dash')
    })

    it('skips non-directory entries in artifacts folder', async () => {
      // Create a valid dashboard
      createArtifactDir('test-agent', 'real-dash', {
        name: 'Real Dashboard',
      })

      // Create a plain file in the artifacts dir
      const artifactsDir = path.join(
        testDir,
        'agents',
        'test-agent',
        'workspace',
        'artifacts'
      )
      fs.writeFileSync(path.join(artifactsDir, 'README.md'), '# Notes')

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].slug).toBe('real-dash')
    })

    it('all results have status stopped and port 0', async () => {
      createArtifactDir('test-agent', 'dash-1', { name: 'D1' })
      createArtifactDir('test-agent', 'dash-2', { name: 'D2' })

      const result = await listArtifactsFromFilesystem('test-agent')
      for (const artifact of result) {
        expect(artifact.status).toBe('stopped')
        expect(artifact.port).toBe(0)
      }
    })

    it('marks a dashboard as first run when node_modules is absent', async () => {
      const dir = createArtifactDir('test-agent', 'cold-dash', { name: 'Cold' })
      fs.rmdirSync(path.join(dir, 'node_modules'))

      const result = await listArtifactsFromFilesystem('test-agent')

      expect(result[0].firstRun).toBe(true)
    })

    it('omits firstRun after dependencies have been installed', async () => {
      createArtifactDir('test-agent', 'warm-dash', { name: 'Warm' })

      const result = await listArtifactsFromFilesystem('test-agent')

      expect(result[0].firstRun).toBeUndefined()
    })

    it('omits hasScreenshot when screenshot.png is absent', async () => {
      createArtifactDir('test-agent', 'no-shot', { name: 'No Shot' })
      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].hasScreenshot).toBeUndefined()
    })

    it('sets hasScreenshot to true when screenshot.png exists', async () => {
      const dir = createArtifactDir('test-agent', 'with-shot', { name: 'With Shot' })
      // Minimal 1x1 PNG; contents don't matter for the existence check.
      fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].hasScreenshot).toBe(true)
    })

    it('treats a directory named screenshot.png as absent', async () => {
      const dir = createArtifactDir('test-agent', 'weird', { name: 'Weird' })
      // hasScreenshot asks whether there is a FILE at that name; a directory is
      // not a screenshot the route could serve, so it is not advertised.
      fs.mkdirSync(path.join(dir, 'screenshot.png'))
      const result = await listArtifactsFromFilesystem('test-agent')
      expect(result).toHaveLength(1)
      expect(result[0].hasScreenshot).toBeUndefined()
    })
  })

  describe('renameArtifactOnFilesystem', () => {
    it('rewrites the manifest name in place, pretty-printed with a trailing newline', async () => {
      const dir = createArtifactDir('test-agent', 'sales', { name: 'Sales', scripts: { start: 'bun run x' } })

      await renameArtifactOnFilesystem('test-agent', 'sales', 'Quarterly Sales')

      const written = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')
      expect(written).toBe(JSON.stringify({ name: 'Quarterly Sales', scripts: { start: 'bun run x' } }, null, 2) + '\n')
      expect((await listArtifactsFromFilesystem('test-agent'))[0].name).toBe('Quarterly Sales')
    })

    it('rejects a slug that is not a plain artifact directory name', async () => {
      createArtifactDir('test-agent', 'sales', { name: 'Sales' })
      await expect(renameArtifactOnFilesystem('test-agent', '../sales', 'x')).rejects.toThrow('Invalid artifact slug')
      await expect(renameArtifactOnFilesystem('test-agent', 'sales/..', 'x')).rejects.toThrow('Invalid artifact slug')
    })

    it('renames an artifact whose directory name is not a widget slug, as the listing shows it', async () => {
      // A directory the agent made by hand: listed like any other artifact,
      // so it has to be manageable like any other.
      const dir = createArtifactDir('test-agent', 'Bad_Slug', { name: 'Hand made' })
      expect((await listArtifactsFromFilesystem('test-agent')).map((a) => a.slug)).toEqual(['Bad_Slug'])

      await renameArtifactOnFilesystem('test-agent', 'Bad_Slug', 'Renamed')

      expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).name).toBe('Renamed')
    })

    it('throws when the artifact has no manifest', async () => {
      await expect(renameArtifactOnFilesystem('test-agent', 'missing', 'x')).rejects.toThrow(/package\.json/)
    })
  })

  describe('deleteArtifactFromFilesystem', () => {
    it('removes the artifact directory and everything in it', async () => {
      const dir = createArtifactDir('test-agent', 'sales', { name: 'Sales' })
      fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad.js'), '')

      await deleteArtifactFromFilesystem('test-agent', 'sales')

      expect(fs.existsSync(dir)).toBe(false)
      expect(await listArtifactsFromFilesystem('test-agent')).toEqual([])
    })

    it('is a no-op for an artifact that does not exist', async () => {
      createArtifactDir('test-agent', 'sales', { name: 'Sales' })
      await expect(deleteArtifactFromFilesystem('test-agent', 'gone')).resolves.toBeUndefined()
      expect(await listArtifactsFromFilesystem('test-agent')).toHaveLength(1)
    })

    it('rejects a slug that is not a plain artifact directory name', async () => {
      createArtifactDir('test-agent', 'sales', { name: 'Sales' })
      await expect(deleteArtifactFromFilesystem('test-agent', '../sales')).rejects.toThrow('Invalid artifact slug')
      await expect(deleteArtifactFromFilesystem('test-agent', '.')).rejects.toThrow('Invalid artifact slug')
      expect(await listArtifactsFromFilesystem('test-agent')).toHaveLength(1)
    })

    it('deletes an artifact whose directory name is not a widget slug, as the listing shows it', async () => {
      const dir = createArtifactDir('test-agent', 'Bad_Slug', { name: 'Hand made' })
      expect((await listArtifactsFromFilesystem('test-agent')).map((a) => a.slug)).toEqual(['Bad_Slug'])

      await deleteArtifactFromFilesystem('test-agent', 'Bad_Slug')

      expect(fs.existsSync(dir)).toBe(false)
      expect(await listArtifactsFromFilesystem('test-agent')).toEqual([])
    })
  })
})
