import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import AdmZip from 'adm-zip'
import type { SkillsetConfig, InstalledAgentMetadata } from '@shared/lib/types/skillset'

// ============================================================================
// Hoisted Mocks - must come before imports of the module under test
// ============================================================================

vi.mock('@shared/lib/services/skillset-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/services/skillset-service')>()
  return {
    ...actual,
    ensureSkillsetCached: vi.fn(),
    getSkillsetRepoDir: vi.fn((id: string) => {
      return `/tmp/mock-skillset-cache/${id}`
    }),
    getSkillsetIndex: vi.fn(),
    readIndexJson: vi.fn(),
    refreshSkillset: vi.fn(),
    copyDirectory: vi.fn(),
    // Keep the real parseSkillFrontmatter for collectAgentRequiredEnvVars tests
  }
})

vi.mock('@shared/lib/services/agent-service', () => ({
  createAgentFromExistingWorkspace: vi.fn(),
  getAgentWithStatus: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveAnthropicApiKey: vi.fn(() => undefined),
  getEffectiveModels: vi.fn(() => ({
    summarizerModel: 'claude-haiku-4-5-20251001',
    agentModel: 'claude-sonnet-4-20250514',
  })),
}))

vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}))

import {
  validateAgentTemplate,
  exportAgentTemplate,
  exportAgentFull,
  importAgentFromTemplate,
  computeAgentTemplateHash,
  getAgentTemplateStatus,
  collectAgentRequiredEnvVars,
  getInstalledAgentMetadata,
  hasOnboardingSkill,
  getDiscoverableAgents,
} from './agent-template-service'
import { createAgentFromExistingWorkspace, getAgentWithStatus } from '@shared/lib/services/agent-service'
import { getSkillsetIndex } from '@shared/lib/services/skillset-service'

// ============================================================================
// Shared Constants & Helpers
// ============================================================================

const MINIMAL_CLAUDE_MD = `---
name: Test Agent
---
# Test Agent
`

const CLAUDE_MD_NO_NAME = `---
description: An agent without a name field
---
# Some Agent
`

const CLAUDE_MD_NO_FRONTMATTER = `# Just Markdown
No frontmatter at all.
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
  // --------------------------------------------------------------------------
  // Basic validation
  // --------------------------------------------------------------------------

  it('accepts a valid minimal template with CLAUDE.md', () => {
    const buf = createZipBuffer({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.agentName).toBe('Test Agent')
    expect(result.fileCount).toBe(1)
    expect(result.stripPrefix).toBe('')
  })

  it('accepts a template with multiple files', () => {
    const buf = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
      'config.json': '{}',
    })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.fileCount).toBe(3)
  })

  it('rejects a template missing CLAUDE.md', () => {
    const buf = createZipBuffer({ 'README.md': '# hi' })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('CLAUDE.md not found')
  })

  it('returns agentName as undefined when CLAUDE.md has no name in frontmatter', () => {
    const buf = createZipBuffer({ 'CLAUDE.md': CLAUDE_MD_NO_NAME })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.agentName).toBeUndefined()
  })

  it('returns agentName as undefined when CLAUDE.md has no frontmatter', () => {
    const buf = createZipBuffer({ 'CLAUDE.md': CLAUDE_MD_NO_FRONTMATTER })
    const result = validateAgentTemplate(buf)
    expect(result.valid).toBe(true)
    expect(result.agentName).toBeUndefined()
  })

  it('handles invalid ZIP buffer gracefully', () => {
    const result = validateAgentTemplate(Buffer.from('not a zip file'))
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.fileCount).toBe(0)
  })

  it('handles empty buffer gracefully', () => {
    const result = validateAgentTemplate(Buffer.alloc(0))
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.fileCount).toBe(0)
  })

  // --------------------------------------------------------------------------
  // Wrapper directory prefix detection
  // --------------------------------------------------------------------------

  describe('wrapper directory prefix', () => {
    it('detects and handles wrapper directory prefix', () => {
      const buf = createZipBuffer({
        'MyAgent-template/CLAUDE.md': MINIMAL_CLAUDE_MD,
        'MyAgent-template/skills/tool.py': 'print("hi")',
      })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(true)
      expect(result.stripPrefix).toBe('MyAgent-template/')
      expect(result.agentName).toBe('Test Agent')
    })

    it('returns empty prefix when files are at root level', () => {
      const buf = createZipBuffer({
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'tool.py': 'print("hi")',
      })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(true)
      expect(result.stripPrefix).toBe('')
    })

    it('returns empty prefix when files have mixed first segments', () => {
      const buf = createZipBuffer({
        'dir1/CLAUDE.md': MINIMAL_CLAUDE_MD,
        'dir2/tool.py': 'print("hi")',
      })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(false) // CLAUDE.md won't be found without a single prefix
      expect(result.stripPrefix).toBe('')
    })

    it('returns empty prefix when a file is at root and others in a dir', () => {
      const buf = createZipBuffer({
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'subdir/tool.py': 'print("hi")',
      })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(true)
      // CLAUDE.md is at root, so no common prefix
      expect(result.stripPrefix).toBe('')
    })

    it('finds CLAUDE.md inside wrapper directory', () => {
      const buf = createZipBuffer({
        'Agent-Export/CLAUDE.md': MINIMAL_CLAUDE_MD,
      })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(true)
      expect(result.stripPrefix).toBe('Agent-Export/')
    })
  })

  // --------------------------------------------------------------------------
  // Filtering - excluded entries
  // --------------------------------------------------------------------------

  describe('excluded entries are not counted toward file limits', () => {
    it('filters out __MACOSX entries', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '__MACOSX/._CLAUDE.md': 'resource fork',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
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
      expect(result.fileCount).toBe(2) // CLAUDE.md + tool.py
    })

    it('filters out .env files at any depth', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.env': 'SECRET=abc',
        'subdir/.env': 'SECRET=def',
        'deep/nested/.env': 'SECRET=ghi',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out .DS_Store files at any depth', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.DS_Store': 'binary',
        'subdir/.DS_Store': 'binary',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out session-metadata.json', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        'session-metadata.json': '{}',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out .superagent-sessions.json', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.superagent-sessions.json': '[]',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('filters out .skillset-agent-metadata.json', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
        '.skillset-agent-metadata.json': '{}',
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(1)
    })

    it('does not count filtered entries toward MAX_FILE_COUNT', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
      }
      for (let i = 0; i < 1500; i++) {
        files[`artifacts/app/node_modules/pkg-${i}/index.js`] = `module.exports = ${i}`
      }
      const result = validateAgentTemplate(createZipBuffer(files))
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
      expect(result.fileCount).toBe(2) // CLAUDE.md + tool.py
    })
  })

  // --------------------------------------------------------------------------
  // File count limits
  // --------------------------------------------------------------------------

  describe('file count limits', () => {
    it('rejects template with too many files (> 2000)', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
      }
      // Create 2001 actual files (beyond the limit)
      for (let i = 0; i < 2001; i++) {
        files[`files/file-${i}.txt`] = `content ${i}`
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Too many files')
      expect(result.error).toContain('max 2000')
    })

    it('accepts template at exactly the file count limit', () => {
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
      }
      // 1999 additional files + CLAUDE.md = 2000 exactly
      for (let i = 0; i < 1999; i++) {
        files[`files/file-${i}.txt`] = `content ${i}`
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(true)
      expect(result.fileCount).toBe(2000)
    })
  })

  // --------------------------------------------------------------------------
  // Size limits
  // --------------------------------------------------------------------------

  describe('total size limits', () => {
    it('rejects template exceeding 200MB uncompressed', () => {
      // Create a file that reports large size via header.
      // AdmZip sets header.size from the actual content, so we create a large content.
      // Use a string that's about 10MB and have 21 of them (210MB total)
      const largeContent = 'x'.repeat(10 * 1024 * 1024)
      const files: Record<string, string> = {
        'CLAUDE.md': MINIMAL_CLAUDE_MD,
      }
      for (let i = 0; i < 21; i++) {
        files[`large-${i}.bin`] = largeContent
      }
      const result = validateAgentTemplate(createZipBuffer(files))
      expect(result.valid).toBe(false)
      expect(result.error).toContain('too large')
      expect(result.error).toContain('200MB')
    })
  })

  // --------------------------------------------------------------------------
  // Path traversal
  // --------------------------------------------------------------------------

  describe('path traversal protection', () => {
    it('rejects entries with .. in the path', () => {
      // AdmZip sanitizes .. from paths during addFile, so we need to
      // manually modify the ZIP buffer to inject a path traversal entry.
      // We create a valid ZIP, then modify the central directory entry name.
      const zip = new AdmZip()
      zip.addFile('CLAUDE.md', Buffer.from(MINIMAL_CLAUDE_MD, 'utf-8'))
      zip.addFile('safe/evil.txt', Buffer.from('root:x:0:0:', 'utf-8'))
      const buf = zip.toBuffer()
      // Replace 'safe/evil.txt' with '../evil.txt' in the buffer
      // The entry name appears in both local file header and central directory
      const searchStr = Buffer.from('safe/evil.txt')
      const replaceStr = Buffer.from('../evil..txt')
      let idx = buf.indexOf(searchStr)
      while (idx !== -1) {
        replaceStr.copy(buf, idx)
        idx = buf.indexOf(searchStr, idx + 1)
      }
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Invalid path')
    })

    it('rejects entries with .. embedded in deeper path segments', () => {
      const zip = new AdmZip()
      zip.addFile('CLAUDE.md', Buffer.from(MINIMAL_CLAUDE_MD, 'utf-8'))
      zip.addFile('foo/ZZDOTDOT/bar.txt', Buffer.from('data', 'utf-8'))
      const buf = zip.toBuffer()
      // Replace 'ZZDOTDOT' with '........' which contains '..'
      const searchStr = Buffer.from('ZZDOTDOT')
      const replaceStr = Buffer.from('........')
      let idx = buf.indexOf(searchStr)
      while (idx !== -1) {
        replaceStr.copy(buf, idx)
        idx = buf.indexOf(searchStr, idx + 1)
      }
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Invalid path')
    })
  })

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles template with only directories (no files)', () => {
      const zip = new AdmZip()
      // Add directory-only entries
      zip.addFile('somedir/', Buffer.alloc(0))
      zip.addFile('anotherdir/', Buffer.alloc(0))
      const result = validateAgentTemplate(zip.toBuffer())
      // No CLAUDE.md found
      expect(result.valid).toBe(false)
      expect(result.error).toContain('CLAUDE.md not found')
    })

    it('finds CLAUDE.md with leading ./ prefix stripped', () => {
      // The code strips leading ./ from entry names
      const buf = createZipBuffer({ './CLAUDE.md': MINIMAL_CLAUDE_MD })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(true)
    })

    it('does not match claude.md (case-sensitive)', () => {
      const buf = createZipBuffer({ 'claude.md': MINIMAL_CLAUDE_MD })
      const result = validateAgentTemplate(buf)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('CLAUDE.md not found')
    })

    it('rejects CLAUDE.md in a subdirectory without matching prefix', () => {
      const buf = createZipBuffer({
        'subdir/CLAUDE.md': MINIMAL_CLAUDE_MD,
        'otherdir/file.txt': 'data',
      })
      const result = validateAgentTemplate(buf)
      // Two different first segments, so no prefix detected
      // CLAUDE.md is not at root -> should fail
      expect(result.valid).toBe(false)
    })
  })
})

// ============================================================================
// validateAgentTemplate - full mode
// ============================================================================

describe('validateAgentTemplate (full mode)', () => {
  it('counts .env files toward fileCount in full mode', () => {
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
      'session-metadata.json': '{}',
    }
    const result = validateAgentTemplate(createZipBuffer(files), 'full')
    expect(result.valid).toBe(true)
    expect(result.fileCount).toBe(3)
  })

  it('excludes .env files from fileCount in template mode', () => {
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
      'session-metadata.json': '{}',
    }
    const result = validateAgentTemplate(createZipBuffer(files), 'template')
    expect(result.valid).toBe(true)
    expect(result.fileCount).toBe(1)
  })

  it('enforces file count limit including excluded files in full mode', () => {
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    }
    for (let i = 0; i < 2001; i++) {
      files[`.env.${i}`] = `SECRET_${i}=value`
    }
    const result = validateAgentTemplate(createZipBuffer(files), 'full')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Too many files')
  })

  it('enforces size limit including excluded files in full mode', () => {
    const largeEnv = 'x'.repeat(10 * 1024 * 1024)
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    }
    for (let i = 0; i < 21; i++) {
      files[`data/large-${i}.env`] = largeEnv
    }
    const result = validateAgentTemplate(createZipBuffer(files), 'full')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('too large')
  })

  it('still filters __MACOSX entries in full mode', () => {
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '__MACOSX/._CLAUDE.md': 'resource fork',
    }
    const result = validateAgentTemplate(createZipBuffer(files), 'full')
    expect(result.valid).toBe(true)
    expect(result.fileCount).toBe(1)
  })

  it('checks path traversal on excluded entries in full mode', () => {
    const zip = new AdmZip()
    zip.addFile('CLAUDE.md', Buffer.from(MINIMAL_CLAUDE_MD, 'utf-8'))
    zip.addFile('safe/evil.txt', Buffer.from('data', 'utf-8'))
    const buf = zip.toBuffer()
    // Replace 'safe/evil.txt' with '../evil..txt' in the buffer
    const searchStr = Buffer.from('safe/evil.txt')
    const replaceStr = Buffer.from('../evil..txt')
    let idx = buf.indexOf(searchStr)
    while (idx !== -1) {
      replaceStr.copy(buf, idx)
      idx = buf.indexOf(searchStr, idx + 1)
    }
    const result = validateAgentTemplate(buf, 'full')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid path')
  })

  it('defaults to template mode when mode is omitted', () => {
    const files: Record<string, string> = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
    }
    const result = validateAgentTemplate(createZipBuffer(files))
    expect(result.fileCount).toBe(1) // .env excluded
  })
})

// ============================================================================
// detectZipPrefix (tested indirectly through validateAgentTemplate)
// ============================================================================

describe('detectZipPrefix (via validateAgentTemplate)', () => {
  it('detects prefix when all entries share a common first directory', () => {
    const buf = createZipBuffer({
      'common-dir/CLAUDE.md': MINIMAL_CLAUDE_MD,
      'common-dir/file1.txt': 'a',
      'common-dir/sub/file2.txt': 'b',
    })
    const result = validateAgentTemplate(buf)
    expect(result.stripPrefix).toBe('common-dir/')
    expect(result.valid).toBe(true)
  })

  it('returns empty prefix when there is no common directory', () => {
    const buf = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'file.txt': 'content',
    })
    const result = validateAgentTemplate(buf)
    expect(result.stripPrefix).toBe('')
  })

  it('returns empty prefix when entries are in different top-level directories', () => {
    const buf = createZipBuffer({
      'dir1/CLAUDE.md': MINIMAL_CLAUDE_MD,
      'dir2/file.txt': 'content',
    })
    const result = validateAgentTemplate(buf)
    expect(result.stripPrefix).toBe('')
  })

  it('ignores __MACOSX entries when detecting prefix', () => {
    const buf = createZipBuffer({
      'MyTemplate/CLAUDE.md': MINIMAL_CLAUDE_MD,
      'MyTemplate/tool.py': 'code',
      '__MACOSX/MyTemplate/._CLAUDE.md': 'resource fork',
    })
    const result = validateAgentTemplate(buf)
    expect(result.stripPrefix).toBe('MyTemplate/')
    expect(result.valid).toBe(true)
  })

  it('handles single file in a directory as common prefix', () => {
    const buf = createZipBuffer({
      'wrapper/CLAUDE.md': MINIMAL_CLAUDE_MD,
    })
    const result = validateAgentTemplate(buf)
    expect(result.stripPrefix).toBe('wrapper/')
    expect(result.valid).toBe(true)
  })
})

// ============================================================================
// walkTemplateFiles (tested indirectly via exportAgentTemplate and computeAgentTemplateHash)
// ============================================================================

describe('walkTemplateFiles (via exportAgentTemplate)', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-template-walk-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function createWorkspace(agentSlug: string, files: Record<string, string>): string {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workspaceDir, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
    return workspaceDir
  }

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

  // ---------- Exclusion by name ----------

  it('excludes node_modules at any depth', async () => {
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

  it('excludes __pycache__ directories at any depth', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
      'skills/__pycache__/tool.cpython-311.pyc': 'bytecode',
      'deep/nested/__pycache__/something.pyc': 'bytecode',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('skills/tool.py')
    expect(entries.some((e) => e.includes('__pycache__'))).toBe(false)
  })

  it('excludes .env files at any depth', async () => {
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

  it('excludes .DS_Store files at any depth', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.DS_Store': 'binary junk',
      'subdir/.DS_Store': 'binary junk',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.DS_Store'))).toBe(false)
  })

  it('excludes session-metadata.json', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'session-metadata.json': '{}',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).not.toContain('session-metadata.json')
  })

  it('excludes .superagent-sessions.json', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.superagent-sessions.json': '[]',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).not.toContain('.superagent-sessions.json')
  })

  it('excludes .skillset-agent-metadata.json', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.skillset-agent-metadata.json': '{}',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).not.toContain('.skillset-agent-metadata.json')
  })

  // ---------- Exclusion by extension ----------

  it('excludes .pyc files at any depth', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'skills/tool.py': 'print("hi")',
      'skills/tool.pyc': 'bytecode',
      'deep/nested/module.pyc': 'bytecode',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('skills/tool.py')
    expect(entries.some((e) => e.endsWith('.pyc'))).toBe(false)
  })

  // ---------- Top-level directory exclusions ----------

  it('excludes top-level uploads/ directory', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'uploads/file.pdf': 'pdf data',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.startsWith('uploads/'))).toBe(false)
  })

  it('excludes top-level downloads/ directory', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'downloads/report.csv': 'csv data',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.startsWith('downloads/'))).toBe(false)
  })

  it('excludes top-level .browser-profile/ directory', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.browser-profile/Default/Cookies': 'binary',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.browser-profile'))).toBe(false)
  })

  it('does NOT exclude nested downloads/ directories (only top-level)', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'artifacts/app/downloads/valid.txt': 'this is fine',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('artifacts/app/downloads/valid.txt')
  })

  it('does NOT exclude nested uploads/ directories (only top-level)', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'artifacts/uploads/valid.txt': 'nested uploads ok',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('artifacts/uploads/valid.txt')
  })

  // ---------- .claude/ directory allowlist ----------

  it('includes .claude/skills/ files', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/my-skill/SKILL.md': 'skill content',
      '.claude/skills/my-skill/tool.py': 'skill code',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('.claude/skills/my-skill/SKILL.md')
    expect(entries).toContain('.claude/skills/my-skill/tool.py')
  })

  it('excludes .claude/projects/', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/projects/settings.json': 'settings',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.claude/projects'))).toBe(false)
  })

  it('excludes .claude/debug/', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/debug/log.txt': 'debug log',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.claude/debug'))).toBe(false)
  })

  it('excludes .claude/todos/', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/todos/todo.md': 'todo items',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.claude/todos'))).toBe(false)
  })

  it('excludes files directly in .claude/ (not in subdirectories)', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/.claude.json': '{}',
      '.claude/stats-cache.json': '{}',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries.some((e) => e.includes('.claude.json'))).toBe(false)
    expect(entries.some((e) => e.includes('stats-cache.json'))).toBe(false)
  })

  it('applies exclusion rules inside .claude/skills/ (e.g., node_modules)', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/my-skill/tool.py': 'code',
      '.claude/skills/my-skill/node_modules/dep/index.js': 'dep',
      '.claude/skills/my-skill/__pycache__/tool.cpython-311.pyc': 'bytecode',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('.claude/skills/my-skill/tool.py')
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false)
    expect(entries.some((e) => e.includes('__pycache__'))).toBe(false)
  })

  // ---------- Empty & deep directories ----------

  it('returns empty list for workspace with only excluded files', async () => {
    createWorkspace('test-agent', {
      '.env': 'SECRET=abc',
      '.DS_Store': 'binary',
      'node_modules/pkg/index.js': 'nope',
    })
    // Will throw because CLAUDE.md is missing, but let's test the hash instead
    const workspaceDir = path.join(testDir, 'agents', 'test-agent', 'workspace')
    const hash = await computeAgentTemplateHash(workspaceDir)
    // Hash of no files should be consistent
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('handles deeply nested directory structures', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'a/b/c/d/e/f/deep-file.txt': 'very deep',
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('a/b/c/d/e/f/deep-file.txt')
  })

  it('handles empty workspace directory gracefully for hash computation', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'empty-agent', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    const hash = await computeAgentTemplateHash(workspaceDir)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('handles .claude/ directory that does not exist', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      // No .claude/ directory at all
    })
    const buf = await exportAgentTemplate('test-agent')
    const entries = getZipEntries(buf)
    expect(entries).toContain('CLAUDE.md')
  })
})

// ============================================================================
// computeAgentTemplateHash
// ============================================================================

describe('computeAgentTemplateHash', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-hash-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function createDir(files: Record<string, string>): string {
    const dir = path.join(testDir, 'workspace')
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
    return dir
  }

  it('returns a 64-character hex string (SHA-256)', async () => {
    const dir = createDir({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const hash = await computeAgentTemplateHash(dir)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces the same hash for the same files', async () => {
    const dir = createDir({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'tool.py': 'print("hello")',
    })
    const hash1 = await computeAgentTemplateHash(dir)
    const hash2 = await computeAgentTemplateHash(dir)
    expect(hash1).toBe(hash2)
  })

  it('produces the same hash regardless of file creation order (deterministic sort)', async () => {
    // Create two separate dirs with same files but different creation order
    const dir1 = path.join(testDir, 'ws1')
    const dir2 = path.join(testDir, 'ws2')

    const files = {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'b.txt': 'content-b',
      'a.txt': 'content-a',
      'sub/z.txt': 'content-z',
      'sub/m.txt': 'content-m',
    }

    // Create files in one order
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir1, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }

    // Create files in reverse order
    const reversedEntries = Object.entries(files).reverse()
    for (const [filePath, content] of reversedEntries) {
      const fullPath = path.join(dir2, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }

    const hash1 = await computeAgentTemplateHash(dir1)
    const hash2 = await computeAgentTemplateHash(dir2)
    expect(hash1).toBe(hash2)
  })

  it('produces different hash when file content changes', async () => {
    const dir = createDir({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const hash1 = await computeAgentTemplateHash(dir)

    // Modify the file
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Modified Agent\n')
    const hash2 = await computeAgentTemplateHash(dir)
    expect(hash1).not.toBe(hash2)
  })

  it('produces different hash when a file is added', async () => {
    const dir = createDir({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const hash1 = await computeAgentTemplateHash(dir)

    // Add a new file
    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'new content')
    const hash2 = await computeAgentTemplateHash(dir)
    expect(hash1).not.toBe(hash2)
  })

  it('produces different hash when a file is removed', async () => {
    const dir = createDir({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'extra.txt': 'extra content',
    })
    const hash1 = await computeAgentTemplateHash(dir)

    // Remove the extra file
    fs.unlinkSync(path.join(dir, 'extra.txt'))
    const hash2 = await computeAgentTemplateHash(dir)
    expect(hash1).not.toBe(hash2)
  })

  it('produces different hash when file path changes but content is same', async () => {
    const dir1 = path.join(testDir, 'path-test1')
    const dir2 = path.join(testDir, 'path-test2')

    fs.mkdirSync(dir1, { recursive: true })
    fs.mkdirSync(dir2, { recursive: true })

    // Same content, different file name
    fs.writeFileSync(path.join(dir1, 'fileA.txt'), 'same content')
    fs.writeFileSync(path.join(dir2, 'fileB.txt'), 'same content')

    const hash1 = await computeAgentTemplateHash(dir1)
    const hash2 = await computeAgentTemplateHash(dir2)
    expect(hash1).not.toBe(hash2)
  })

  it('ignores excluded files when computing hash', async () => {
    const dir1 = createDir({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const hash1 = await computeAgentTemplateHash(dir1)

    // Add excluded files and check hash is unchanged
    fs.writeFileSync(path.join(dir1, '.env'), 'SECRET=abc')
    fs.writeFileSync(path.join(dir1, '.DS_Store'), 'binary')
    fs.mkdirSync(path.join(dir1, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir1, 'node_modules', 'pkg', 'index.js'), 'nope')

    const hash2 = await computeAgentTemplateHash(dir1)
    expect(hash1).toBe(hash2)
  })

  it('ignores top-level excluded directories when computing hash', async () => {
    const dir1 = createDir({ 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const hash1 = await computeAgentTemplateHash(dir1)

    // Add top-level excluded dirs
    fs.mkdirSync(path.join(dir1, 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(dir1, 'uploads', 'file.pdf'), 'pdf')
    fs.mkdirSync(path.join(dir1, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir1, 'downloads', 'report.csv'), 'csv')
    fs.mkdirSync(path.join(dir1, '.browser-profile'), { recursive: true })
    fs.writeFileSync(path.join(dir1, '.browser-profile', 'cookie'), 'data')

    const hash2 = await computeAgentTemplateHash(dir1)
    expect(hash1).toBe(hash2)
  })

  it('returns deterministic hash for empty directory', async () => {
    const dir = path.join(testDir, 'empty-ws')
    fs.mkdirSync(dir, { recursive: true })
    const hash1 = await computeAgentTemplateHash(dir)
    const hash2 = await computeAgentTemplateHash(dir)
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ============================================================================
// getAgentTemplateStatus
// ============================================================================

describe('getAgentTemplateStatus', () => {
  let testDir: string
  let originalEnv: string | undefined

  const mockGetSkillsetIndex = vi.mocked(getSkillsetIndex)

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-status-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    vi.clearAllMocks()
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function createWorkspace(agentSlug: string, files: Record<string, string>): string {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workspaceDir, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
    return workspaceDir
  }

  async function writeMetadata(agentSlug: string, meta: InstalledAgentMetadata): Promise<void> {
    const metaPath = path.join(testDir, 'agents', agentSlug, 'workspace', '.skillset-agent-metadata.json')
    fs.mkdirSync(path.dirname(metaPath), { recursive: true })
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  }

  function buildSkillsetConfig(overrides: Partial<SkillsetConfig> = {}): SkillsetConfig {
    return {
      id: 'test-skillset',
      url: 'https://github.com/TestOrg/agents',
      name: 'Test Skillset',
      description: 'A test skillset',
      addedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  // ---------- local ----------

  it('returns { type: "local" } when agent has no metadata file', async () => {
    createWorkspace('local-agent', { 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const result = await getAgentTemplateStatus('local-agent', [])
    expect(result).toEqual({ type: 'local' })
  })

  it('returns { type: "local" } when metadata file does not exist', async () => {
    createWorkspace('no-meta-agent', { 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const result = await getAgentTemplateStatus('no-meta-agent', [buildSkillsetConfig()])
    expect(result).toEqual({ type: 'local' })
  })

  // ---------- locally_modified (hash mismatch) ----------

  it('returns { type: "locally_modified" } when current hash differs from original', async () => {
    createWorkspace('modified-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    // Compute the hash with original content, then write metadata with a DIFFERENT hash
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'aaaa0000bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777',
    }
    await writeMetadata('modified-agent', meta)

    const config = buildSkillsetConfig()
    const result = await getAgentTemplateStatus('modified-agent', [config])

    expect(result.type).toBe('locally_modified')
    if (result.type === 'locally_modified') {
      expect(result.skillsetId).toBe('test-skillset')
      expect(result.skillsetName).toBe('Test Skillset')
    }
  })

  it('returns locally_modified with openPrUrl when hash matches but openPrUrl is set', async () => {
    const workspaceDir = createWorkspace('pr-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const prUrl = 'https://github.com/TestOrg/agents/pull/42'
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
      openPrUrl: prUrl,
    }
    await writeMetadata('pr-agent', meta)

    const config = buildSkillsetConfig()
    const result = await getAgentTemplateStatus('pr-agent', [config])

    expect(result.type).toBe('locally_modified')
    if (result.type === 'locally_modified') {
      expect(result.openPrUrl).toBe(prUrl)
    }
  })

  it('includes openPrUrl in locally_modified when hash also mismatches', async () => {
    createWorkspace('both-modified-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const prUrl = 'https://github.com/TestOrg/agents/pull/99'
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'different_hash_from_current_0000000000000000000000000000000000000000',
      openPrUrl: prUrl,
    }
    await writeMetadata('both-modified-agent', meta)

    const config = buildSkillsetConfig()
    const result = await getAgentTemplateStatus('both-modified-agent', [config])

    expect(result.type).toBe('locally_modified')
    if (result.type === 'locally_modified') {
      expect(result.openPrUrl).toBe(prUrl)
    }
  })

  // ---------- update_available ----------

  it('returns { type: "update_available" } when remote version differs from installed', async () => {
    const workspaceDir = createWorkspace('updatable-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('updatable-agent', meta)

    const config = buildSkillsetConfig()
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
      agents: [{
        name: 'Test Agent',
        path: 'agents/test-agent/',
        description: 'An agent',
        version: '2.0.0', // Newer version than installed
      }],
    })

    const result = await getAgentTemplateStatus('updatable-agent', [config])

    expect(result.type).toBe('update_available')
    if (result.type === 'update_available') {
      expect(result.skillsetId).toBe('test-skillset')
      expect(result.skillsetName).toBe('Test Skillset')
      expect(result.latestVersion).toBe('2.0.0')
    }
  })

  // ---------- up_to_date ----------

  it('returns { type: "up_to_date" } when hash matches and version matches', async () => {
    const workspaceDir = createWorkspace('uptodate-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('uptodate-agent', meta)

    const config = buildSkillsetConfig()
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
      agents: [{
        name: 'Test Agent',
        path: 'agents/test-agent/',
        description: 'An agent',
        version: '1.0.0', // Same version as installed
      }],
    })

    const result = await getAgentTemplateStatus('uptodate-agent', [config])

    expect(result.type).toBe('up_to_date')
    if (result.type === 'up_to_date') {
      expect(result.skillsetId).toBe('test-skillset')
      expect(result.skillsetName).toBe('Test Skillset')
    }
  })

  it('returns up_to_date when agent is not found in skillset index (no version mismatch)', async () => {
    const workspaceDir = createWorkspace('no-entry-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('no-entry-agent', meta)

    const config = buildSkillsetConfig()
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
      agents: [], // Agent not in index
    })

    const result = await getAgentTemplateStatus('no-entry-agent', [config])
    expect(result.type).toBe('up_to_date')
  })

  it('returns up_to_date when skillset index is null', async () => {
    const workspaceDir = createWorkspace('null-index-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('null-index-agent', meta)

    const config = buildSkillsetConfig()
    mockGetSkillsetIndex.mockResolvedValue(null)

    const result = await getAgentTemplateStatus('null-index-agent', [config])
    expect(result.type).toBe('up_to_date')
  })

  // ---------- skillsetName fallback ----------

  it('uses skillset config name when available', async () => {
    const workspaceDir = createWorkspace('named-ss-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('named-ss-agent', meta)

    const config = buildSkillsetConfig({ name: 'My Custom Skillset Name' })
    mockGetSkillsetIndex.mockResolvedValue(null)

    const result = await getAgentTemplateStatus('named-ss-agent', [config])
    if (result.type !== 'local') {
      expect(result.skillsetName).toBe('My Custom Skillset Name')
    }
  })

  it('falls back to skillsetId when skillset config is not found', async () => {
    const workspaceDir = createWorkspace('no-config-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'orphaned-skillset-id',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('no-config-agent', meta)

    // Pass skillsets that do NOT include this agent's skillsetId
    mockGetSkillsetIndex.mockResolvedValue(null)

    const result = await getAgentTemplateStatus('no-config-agent', [])
    if (result.type !== 'local') {
      expect(result.skillsetName).toBe('orphaned-skillset-id')
    }
  })

  it('returns local when platform template belongs to a hidden org skillset', async () => {
    const workspaceDir = createWorkspace('hidden-platform-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
    })

    const currentHash = await computeAgentTemplateHash(workspaceDir)
    const meta: InstalledAgentMetadata = {
      skillsetId: 'platform--skillsets/org_old/local--local',
      skillsetUrl: 'https://platform.example/skills/repo',
      provider: 'platform',
      platformRepoId: 'skillsets/org_old/local',
      skillsetName: 'local',
      agentName: 'Hidden Platform Agent',
      agentPath: 'agents/hidden-platform-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: currentHash,
    }
    await writeMetadata('hidden-platform-agent', meta)

    const config = buildSkillsetConfig({
      id: 'platform--skillsets/org_old/local--local',
      name: 'local',
      provider: 'platform',
      platformRepoId: 'skillsets/org_old/local',
      platformOrgId: 'org_old',
      platformOrgName: 'Old Org',
    })

    const result = await getAgentTemplateStatus('hidden-platform-agent', [config], {
      currentPlatformOrgId: 'org_current',
    })
    expect(result).toEqual({
      type: 'local',
      skillsetId: 'platform--skillsets/org_old/local--local',
      skillsetName: 'local',
      skillsetOrgId: 'org_old',
      skillsetOrgName: 'Old Org',
      publishable: false,
    })
  })
})

// ============================================================================
// getInstalledAgentMetadata
// ============================================================================

describe('getInstalledAgentMetadata', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-meta-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('returns null when metadata file does not exist', async () => {
    const result = await getInstalledAgentMetadata('nonexistent-agent')
    expect(result).toBeNull()
  })

  it('returns parsed metadata when file exists', async () => {
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc123',
    }
    const metaPath = path.join(testDir, 'agents', 'test-agent', 'workspace', '.skillset-agent-metadata.json')
    fs.mkdirSync(path.dirname(metaPath), { recursive: true })
    fs.writeFileSync(metaPath, JSON.stringify(meta))

    const result = await getInstalledAgentMetadata('test-agent')
    expect(result).toEqual(meta)
  })

  it('returns null when metadata file contains invalid JSON', async () => {
    const metaPath = path.join(testDir, 'agents', 'bad-json-agent', 'workspace', '.skillset-agent-metadata.json')
    fs.mkdirSync(path.dirname(metaPath), { recursive: true })
    fs.writeFileSync(metaPath, 'not valid json {{{')

    const result = await getInstalledAgentMetadata('bad-json-agent')
    expect(result).toBeNull()
  })

  it('returns metadata with optional openPrUrl', async () => {
    const meta: InstalledAgentMetadata = {
      skillsetId: 'test-skillset',
      skillsetUrl: 'https://github.com/TestOrg/agents',
      agentName: 'Test Agent',
      agentPath: 'agents/test-agent/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc123',
      openPrUrl: 'https://github.com/TestOrg/agents/pull/1',
    }
    const metaPath = path.join(testDir, 'agents', 'pr-agent', 'workspace', '.skillset-agent-metadata.json')
    fs.mkdirSync(path.dirname(metaPath), { recursive: true })
    fs.writeFileSync(metaPath, JSON.stringify(meta))

    const result = await getInstalledAgentMetadata('pr-agent')
    expect(result?.openPrUrl).toBe('https://github.com/TestOrg/agents/pull/1')
  })
})

// ============================================================================
// hasOnboardingSkill
// ============================================================================

describe('hasOnboardingSkill', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-onboarding-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('returns true when agent-onboarding SKILL.md exists', async () => {
    const skillPath = path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'skills', 'agent-onboarding', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, '# Onboarding Skill')

    const result = await hasOnboardingSkill('test-agent')
    expect(result).toBe(true)
  })

  it('returns false when agent-onboarding directory does not exist', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'test-agent', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })

    const result = await hasOnboardingSkill('test-agent')
    expect(result).toBe(false)
  })

  it('returns false when workspace does not exist', async () => {
    const result = await hasOnboardingSkill('nonexistent-agent')
    expect(result).toBe(false)
  })
})

// ============================================================================
// getDiscoverableAgents
// ============================================================================

describe('getDiscoverableAgents', () => {
  const mockGetSkillsetIndex = vi.mocked(getSkillsetIndex)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function buildSkillsetConfig(overrides: Partial<SkillsetConfig> = {}): SkillsetConfig {
    return {
      id: 'test-skillset',
      url: 'https://github.com/TestOrg/agents',
      name: 'Test Skillset',
      description: 'A test skillset',
      addedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('returns empty array when no skillsets configured', async () => {
    const result = await getDiscoverableAgents([])
    expect(result).toEqual([])
  })

  it('returns empty array when skillset has no agents', async () => {
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
      agents: [],
    })

    const result = await getDiscoverableAgents([buildSkillsetConfig()])
    expect(result).toEqual([])
  })

  it('returns empty array when skillset index is null', async () => {
    mockGetSkillsetIndex.mockResolvedValue(null)

    const result = await getDiscoverableAgents([buildSkillsetConfig()])
    expect(result).toEqual([])
  })

  it('returns empty array when skillset has no agents field', async () => {
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
    })

    const result = await getDiscoverableAgents([buildSkillsetConfig()])
    expect(result).toEqual([])
  })

  it('returns agents from a single skillset', async () => {
    mockGetSkillsetIndex.mockResolvedValue({
      skillset_name: 'Test Skillset',
      description: 'test',
      version: '1.0.0',
      skills: [],
      agents: [
        { name: 'Research Agent', path: 'agents/research/', description: 'Does research', version: '1.0.0' },
        { name: 'Code Agent', path: 'agents/code/', description: 'Writes code', version: '2.0.0' },
      ],
    })

    const result = await getDiscoverableAgents([buildSkillsetConfig()])
    expect(result).toHaveLength(2)
    // Sorted alphabetically
    expect(result[0].name).toBe('Code Agent')
    expect(result[1].name).toBe('Research Agent')
    expect(result[0].skillsetId).toBe('test-skillset')
    expect(result[0].skillsetName).toBe('Test Skillset')
  })

  it('returns agents from multiple skillsets sorted alphabetically', async () => {
    mockGetSkillsetIndex.mockImplementation(async (id: string) => {
      if (id === 'skillset-a') {
        return {
          skillset_name: 'Skillset A',
          description: 'A',
          version: '1.0.0',
          skills: [],
          agents: [
            { name: 'Zebra Agent', path: 'agents/zebra/', description: 'Z', version: '1.0.0' },
          ],
        }
      }
      if (id === 'skillset-b') {
        return {
          skillset_name: 'Skillset B',
          description: 'B',
          version: '1.0.0',
          skills: [],
          agents: [
            { name: 'Alpha Agent', path: 'agents/alpha/', description: 'A', version: '1.0.0' },
          ],
        }
      }
      return null
    })

    const result = await getDiscoverableAgents([
      buildSkillsetConfig({ id: 'skillset-a', name: 'Skillset A' }),
      buildSkillsetConfig({ id: 'skillset-b', name: 'Skillset B' }),
    ])

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Alpha Agent')
    expect(result[0].skillsetName).toBe('Skillset B')
    expect(result[1].name).toBe('Zebra Agent')
    expect(result[1].skillsetName).toBe('Skillset A')
  })
})

// ============================================================================
// collectAgentRequiredEnvVars
// ============================================================================

describe('collectAgentRequiredEnvVars', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-env-vars-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function createWorkspace(agentSlug: string, files: Record<string, string>): void {
    const workspaceDir = path.join(testDir, 'agents', agentSlug, 'workspace')
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(workspaceDir, filePath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
  }

  it('returns empty array when agent has no skills directory', async () => {
    createWorkspace('test-agent', { 'CLAUDE.md': MINIMAL_CLAUDE_MD })
    const result = await collectAgentRequiredEnvVars('test-agent')
    expect(result).toEqual([])
  })

  it('returns empty array when skills have no required_env_vars', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/my-skill/SKILL.md': `---
description: A skill with no secrets
---
# My Skill`,
    })
    const result = await collectAgentRequiredEnvVars('test-agent')
    expect(result).toEqual([])
  })

  it('collects required_env_vars from a single skill', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/db-query/SKILL.md': `---
description: Query the database
metadata:
  required_env_vars:
    - name: DB_HOST
      description: Database hostname
    - name: DB_PASSWORD
      description: Database password
---
# DB Query`,
    })
    const result = await collectAgentRequiredEnvVars('test-agent')
    expect(result).toEqual([
      { name: 'DB_HOST', description: 'Database hostname' },
      { name: 'DB_PASSWORD', description: 'Database password' },
    ])
  })

  it('collects and de-duplicates required_env_vars across multiple skills', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key
    - name: SECRET_A
      description: Secret for A
---
# Skill A`,
      '.claude/skills/skill-b/SKILL.md': `---
description: Skill B
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key (duplicate)
    - name: SECRET_B
      description: Secret for B
---
# Skill B`,
    })
    const result = await collectAgentRequiredEnvVars('test-agent')
    const names = result.map((v) => v.name).sort()
    expect(names).toEqual(['API_KEY', 'SECRET_A', 'SECRET_B'])
  })

  it('skips skill directories without SKILL.md', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/no-md/script.py': 'print("hi")',
      '.claude/skills/has-md/SKILL.md': `---
description: Has secrets
metadata:
  required_env_vars:
    - name: TOKEN
      description: Auth token
---
# Has MD`,
    })
    const result = await collectAgentRequiredEnvVars('test-agent')
    expect(result).toEqual([{ name: 'TOKEN', description: 'Auth token' }])
  })

  it('handles a mix of skills with and without required_env_vars', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.claude/skills/no-secrets/SKILL.md': `---
description: No secrets needed
---
# No Secrets`,
      '.claude/skills/has-secrets/SKILL.md': `---
description: Needs secrets
metadata:
  required_env_vars:
    - name: MY_SECRET
      description: A secret value
---
# Has Secrets`,
    })
    const result = await collectAgentRequiredEnvVars('test-agent')
    expect(result).toEqual([{ name: 'MY_SECRET', description: 'A secret value' }])
  })

  it('returns empty array when workspace does not exist', async () => {
    const result = await collectAgentRequiredEnvVars('nonexistent-agent')
    expect(result).toEqual([])
  })

  it('filters out required env vars already present in the agent .env when requested', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'API_KEY=present\n',
      '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key
    - name: SECRET_A
      description: Secret for A
---
# Skill A`,
    })

    const result = await collectAgentRequiredEnvVars('test-agent', {
      excludeExistingSecrets: true,
    })

    expect(result).toEqual([{ name: 'SECRET_A', description: 'Secret for A' }])
  })

  it('treats quoted and commented .env entries as existing secrets', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'API_KEY="abc 123"\nTOKEN=value  # Auth token\n',
      '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key
    - name: TOKEN
      description: Access token
    - name: SECRET_A
      description: Secret for A
---
# Skill A`,
    })

    const result = await collectAgentRequiredEnvVars('test-agent', {
      excludeExistingSecrets: true,
    })

    expect(result).toEqual([{ name: 'SECRET_A', description: 'Secret for A' }])
  })

  it('matches existing secrets by exact env var name', async () => {
    createWorkspace('test-agent', {
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'api_key=present\n',
      '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key
---
# Skill A`,
    })

    const result = await collectAgentRequiredEnvVars('test-agent', {
      excludeExistingSecrets: true,
    })

    expect(result).toEqual([{ name: 'API_KEY', description: 'Shared API key' }])
  })
})

// ============================================================================
// exportAgentTemplate - error cases
// ============================================================================

describe('exportAgentTemplate - error cases', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-export-error-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('throws when workspace does not exist', async () => {
    await expect(exportAgentTemplate('nonexistent-agent')).rejects.toThrow(
      'Agent workspace not found'
    )
  })

  it('throws when CLAUDE.md is missing from workspace', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'no-claude', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# No Claude MD here')

    await expect(exportAgentTemplate('no-claude')).rejects.toThrow(
      'CLAUDE.md not found'
    )
  })
})

// ============================================================================
// exportAgentFull
// ============================================================================

describe('exportAgentFull', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-export-full-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('throws when workspace does not exist', async () => {
    await expect(exportAgentFull('nonexistent-agent')).rejects.toThrow(
      'Agent workspace not found'
    )
  })

  it('includes .env in the export', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'full-agent', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), MINIMAL_CLAUDE_MD)
    fs.writeFileSync(path.join(workspaceDir, '.env'), 'SECRET=abc')

    const zipBuffer = await exportAgentFull('full-agent')
    const zip = new AdmZip(zipBuffer)
    const entryNames = zip.getEntries().map((e) => e.entryName)

    expect(entryNames).toContain('CLAUDE.md')
    expect(entryNames).toContain('.env')
  })

  it('includes session-metadata.json in the export', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'full-agent', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), MINIMAL_CLAUDE_MD)
    fs.writeFileSync(path.join(workspaceDir, 'session-metadata.json'), '{}')

    const zipBuffer = await exportAgentFull('full-agent')
    const zip = new AdmZip(zipBuffer)
    const entryNames = zip.getEntries().map((e) => e.entryName)

    expect(entryNames).toContain('session-metadata.json')
  })

  it('excludes node_modules from the export', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'full-agent', 'workspace')
    const nmDir = path.join(workspaceDir, 'node_modules', 'pkg')
    fs.mkdirSync(nmDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), MINIMAL_CLAUDE_MD)
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = 1')

    const zipBuffer = await exportAgentFull('full-agent')
    const zip = new AdmZip(zipBuffer)
    const entryNames = zip.getEntries().map((e) => e.entryName)

    expect(entryNames).not.toContain('node_modules/pkg/index.js')
  })

  it('skips symlinks without hanging', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'full-agent', 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), MINIMAL_CLAUDE_MD)

    // Create a broken symlink (points to a non-existent target)
    const linkPath = path.join(workspaceDir, 'broken-link')
    try {
      fs.symlinkSync('/nonexistent/target/file.txt', linkPath)
    } catch {
      // Skip on systems where symlink creation requires elevated privileges
      return
    }

    const zipBuffer = await exportAgentFull('full-agent')
    const zip = new AdmZip(zipBuffer)
    const entryNames = zip.getEntries().map((e) => e.entryName)

    expect(entryNames).toContain('CLAUDE.md')
    expect(entryNames).not.toContain('broken-link')
  })

  it('excludes .browser-profile from the export', async () => {
    const workspaceDir = path.join(testDir, 'agents', 'full-agent', 'workspace')
    const bpDir = path.join(workspaceDir, '.browser-profile')
    fs.mkdirSync(bpDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), MINIMAL_CLAUDE_MD)
    fs.writeFileSync(path.join(bpDir, 'cookies.db'), 'data')

    const zipBuffer = await exportAgentFull('full-agent')
    const zip = new AdmZip(zipBuffer)
    const entryNames = zip.getEntries().map((e) => e.entryName)

    expect(entryNames).not.toContain('.browser-profile/cookies.db')
  })
})

// ============================================================================
// importAgentFromTemplate - full mode
// ============================================================================

describe('importAgentFromTemplate (full mode)', () => {
  let testDir: string
  let originalEnv: string | undefined
  const mockCreateAgent = vi.mocked(createAgentFromExistingWorkspace)
  const mockGetAgentWithStatus = vi.mocked(getAgentWithStatus)

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'agent-import-test-')
    )
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    vi.clearAllMocks()
  })

  afterEach(async () => {
    process.env.SUPERAGENT_DATA_DIR = originalEnv
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function setupAgentMock(slug: string) {
    const agent = { slug, name: 'Test Agent' } as any
    mockCreateAgent.mockResolvedValue(agent)
    mockGetAgentWithStatus.mockResolvedValue(agent)
    // Ensure workspace dir exists for the mock agent
    const workspaceDir = path.join(testDir, 'agents', slug, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    return workspaceDir
  }

  it('imports .env in full mode', async () => {
    const workspaceDir = setupAgentMock('import-full-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
    })

    await importAgentFromTemplate(zipBuffer, undefined, 'full')

    const envPath = path.join(workspaceDir, '.env')
    expect(fs.existsSync(envPath)).toBe(true)
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('SECRET=abc')
  })

  it('full import can satisfy required env vars from imported .env', async () => {
    setupAgentMock('import-full-env-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'API_KEY=present\n',
      '.claude/skills/skill-a/SKILL.md': `---
description: Skill A
metadata:
  required_env_vars:
    - name: API_KEY
      description: Shared API key
    - name: SECRET_A
      description: Secret for A
---
# Skill A`,
    })

    const agent = await importAgentFromTemplate(zipBuffer, undefined, 'full')
    const result = await collectAgentRequiredEnvVars(agent.slug, {
      excludeExistingSecrets: true,
    })

    expect(result).toEqual([{ name: 'SECRET_A', description: 'Secret for A' }])
  })

  it('strips .env in template mode', async () => {
    const workspaceDir = setupAgentMock('import-template-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
    })

    await importAgentFromTemplate(zipBuffer, undefined, 'template')

    const envPath = path.join(workspaceDir, '.env')
    expect(fs.existsSync(envPath)).toBe(false)
  })

  it('imports session-metadata.json in full mode', async () => {
    const workspaceDir = setupAgentMock('import-session-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      'session-metadata.json': '{"sessions":[]}',
    })

    await importAgentFromTemplate(zipBuffer, undefined, 'full')

    const sessionPath = path.join(workspaceDir, 'session-metadata.json')
    expect(fs.existsSync(sessionPath)).toBe(true)
  })

  it('still blocks path traversal in full mode', async () => {
    setupAgentMock('import-traversal-agent')
    // Create a zip with path traversal — the import should silently skip it
    const zip = new AdmZip()
    zip.addFile('CLAUDE.md', Buffer.from(MINIMAL_CLAUDE_MD, 'utf-8'))
    zip.addFile('safe/evil.txt', Buffer.from('data', 'utf-8'))
    const buf = zip.toBuffer()
    const searchStr = Buffer.from('safe/evil.txt')
    const replaceStr = Buffer.from('../evil..txt')
    let idx = buf.indexOf(searchStr)
    while (idx !== -1) {
      replaceStr.copy(buf, idx)
      idx = buf.indexOf(searchStr, idx + 1)
    }
    // The validation step will reject this
    await expect(importAgentFromTemplate(buf, undefined, 'full')).rejects.toThrow('Invalid path')
  })

  it('still filters __MACOSX in full mode', async () => {
    const workspaceDir = setupAgentMock('import-macosx-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '__MACOSX/._CLAUDE.md': 'resource fork junk',
    })

    await importAgentFromTemplate(zipBuffer, undefined, 'full')

    // __MACOSX should not be extracted
    expect(fs.existsSync(path.join(workspaceDir, '__MACOSX'))).toBe(false)
  })

  it('defaults to template mode', async () => {
    const workspaceDir = setupAgentMock('import-default-agent')
    const zipBuffer = createZipBuffer({
      'CLAUDE.md': MINIMAL_CLAUDE_MD,
      '.env': 'SECRET=abc',
    })

    await importAgentFromTemplate(zipBuffer)

    const envPath = path.join(workspaceDir, '.env')
    expect(fs.existsSync(envPath)).toBe(false)
  })
})
