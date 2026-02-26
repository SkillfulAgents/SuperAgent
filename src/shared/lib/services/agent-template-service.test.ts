import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import AdmZip from 'adm-zip'
import { validateAgentTemplate, exportAgentTemplate } from './agent-template-service'

const MINIMAL_CLAUDE_MD = `---
name: Test Agent
---
# Test Agent
`

/** Helper: create a zip buffer from a map of { path: content } */
function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [filePath, content] of Object.entries(files)) {
    zip.addFile(filePath, Buffer.from(content, 'utf-8'))
  }
  return zip.toBuffer()
}

// ============================================================================
// validateAgentTemplate
// ============================================================================

describe('validateAgentTemplate', () => {
  it('accepts a valid minimal template', () => {
    const buf = createZipBuffer({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.agentName).toBe('Test Agent')
  })

  it('accepts a template with wrapper directory prefix', () => {
    const buf = createZipBuffer({
      'MyAgent-template/CLAUDE.md': MINIMAL_CLAUDE_MD,
      'MyAgent-template/skills/tool.py': 'print("hi")',
    })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.stripPrefix).toBe('MyAgent-template/')
  })

  it('rejects a template missing CLAUDE.md', () => {
    const buf = createZipBuffer({ 'README.md': '# hi' })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('CLAUDE.md not found')
  })

  // ---------------------------------------------------------------------------
  // Filtering tests
  // ---------------------------------------------------------------------------

  describe('excluded entries are not counted toward file limits', () => {
    it('filters out __MACOSX entries', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '__MACOSX/._CLAUDE.md': 'resource fork',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      // Only CLAUDE.md should count
      expect(result.fileCount).toBe(1)
    })

    it('filters out node_modules at any depth', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'artifacts/app/node_modules/lodash/index.js': 'module.exports = {}',
        'artifacts/app/node_modules/lodash/package.json': '{}',
        'node_modules/something/index.js': 'nope',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out __pycache__ directories', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'skills/__pycache__/tool.cpython-311.pyc': 'bytecode',
        '__pycache__/other.cpython-311.pyc': 'bytecode',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out .pyc files', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'skills/tool.py': 'print("hi")',
        'skills/tool.pyc': 'bytecode',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      // CLAUDE.md + tool.py, but NOT tool.pyc
      expect(result.fileCount).toBe(2)
    })

    it('filters out .env files', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.env': 'SECRET=abc',
        'subdir/.env': 'SECRET=def',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out .DS_Store files', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.DS_Store': 'binary',
        'subdir/.DS_Store': 'binary',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('does not count filtered entries toward MAX_FILE_COUNT', () => {
      // Create a zip with 1 real file + many node_modules files
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
      }
      for (let i = 0; i < 1500; i++) {
        files[`artifacts/app/node_modules/pkg-${i}/index.js`] = `module.exports = ${i}`
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      // Should pass - the 1500 node_modules files should be filtered out
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })
  })

  describe('filtering with wrapper prefix', () => {
    it('filters excluded entries inside a wrapper directory', () => {
      const files: Record<string, string> = {
        'Agent-template/CLAUDE.md': MINIMAL_CLAUDE_MD,
        'Agent-template/skills/tool.py': 'print("hi")',
        'Agent-template/skills/__pycache__/tool.cpython-311.pyc': 'bytecode',
        'Agent-template/node_modules/pkg/index.js': 'nope',
        'Agent-template/.DS_Store': 'binary',
        'Agent-template/skills/tool.pyc': 'bytecode',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.stripPrefix).toBe('Agent-template/')
      // Only CLAUDE.md + tool.py should count
      expect(result.fileCount).toBe(2)
    })
  })
})

// ============================================================================
// exportAgentTemplate
// ============================================================================

describe('exportAgentTemplate', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-template-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  /** Create a workspace directory with given files */
  function createWorkspace(agentSlug: string, files: Record<string, string>): string {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workspaceDir, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
    return workspaceDir
  }

  /** Extract zip buffer and return a set of entry paths */
  function getZipEntries(buf: Buffer): string[] {
    const zip = new AdmZip(buf)
    return zip.getEntries().map((e) => e.entryName).sort()
  }

  it('exports a basic agent template', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('CLAUDE.md')
    expect(entries).toContain('skills/tool.py')
  })

  it('excludes node_modules from export', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'artifacts/app/node_modules/lodash/index.js': 'module.exports = {}',
      'artifacts/app/index.js': 'import lodash from "lodash"',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('CLAUDE.md')
    expect(entries).toContain('artifacts/app/index.js')
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false)
  })

  it('excludes __pycache__ from export', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
      'skills/__pycache__/tool.cpython-311.pyc': 'bytecode',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('skills/tool.py')
    expect(entries.some((e) => e.includes('__pycache__'))).toBe(false)
  })

  it('excludes .pyc files from export', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
      'skills/tool.pyc': 'bytecode',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('skills/tool.py')
    expect(entries.some((e) => e.endsWith('.pyc'))).toBe(false)
  })

  it('excludes .env files from export', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
      'subdir/.env': 'SECRET=def',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('CLAUDE.md')
    expect(entries.some((e) => e.includes('.env'))).toBe(false)
  })

  it('excludes top-level uploads and downloads dirs from export', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'uploads/file.pdf': 'pdf data',
      'downloads/report.csv': 'csv data',
      'artifacts/app/downloads/valid.txt': 'this is fine',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('CLAUDE.md')
    // Top-level uploads/ and downloads/ should be excluded
    expect(entries.some((e) => e.startsWith('uploads/'))).toBe(false)
    expect(entries.some((e) => e.startsWith('downloads/'))).toBe(false)
    // But nested downloads/ inside artifacts should be fine
    expect(entries).toContain('artifacts/app/downloads/valid.txt')
  })

  it('excludes .claude/ dirs except allowlisted ones', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/my-skill.py': 'skill code',
      '.claude/projects/settings.json': 'settings',
      '.claude/debug/log.txt': 'debug log',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('.claude/skills/my-skill.py')
    expect(entries.some((e) => e.includes('.claude/projects'))).toBe(false)
    expect(entries.some((e) => e.includes('.claude/debug'))).toBe(false)
  })
})
