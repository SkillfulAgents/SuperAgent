import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { listArtifactsFromFilesystem } from './artifact-service'

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
    return dir
  }

  describe('listArtifactsFromFilesystem', () => {
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
  })
})
