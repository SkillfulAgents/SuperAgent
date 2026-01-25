import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  generateAgentSlug,
  generateUniqueAgentSlug,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
  listDirectories,
  directoryExists,
  fileExists,
  removeDirectory,
  ensureDirectory,
  readFileOrNull,
  writeFile,
  parseJsonl,
  readJsonlFile,
  streamJsonlFile,
  getAgentsDir,
  getAgentDir,
  getAgentWorkspaceDir,
  getAgentClaudeMdPath,
  getAgentEnvPath,
  getAgentSessionMetadataPath,
  getAgentClaudeConfigDir,
  getAgentSessionsDir,
  getSessionJsonlPath,
} from './file-storage'

// ============================================================================
// Test Utilities
// ============================================================================

let testDir: string

beforeEach(async () => {
  // Create a unique temp directory for each test
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-storage-test-'))
})

afterEach(async () => {
  // Clean up temp directory
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

// ============================================================================
// Slug Generation Tests
// ============================================================================

describe('generateAgentSlug', () => {
  it('converts name to lowercase slug with random suffix', () => {
    const slug = generateAgentSlug('My Cool Agent')
    expect(slug).toMatch(/^my-cool-agent-[a-z0-9]{6}$/)
  })

  it('replaces special characters with hyphens', () => {
    const slug = generateAgentSlug('Test @#$ Agent!!!')
    expect(slug).toMatch(/^test-agent-[a-z0-9]{6}$/)
  })

  it('removes leading and trailing hyphens', () => {
    const slug = generateAgentSlug('---Test---')
    expect(slug).toMatch(/^test-[a-z0-9]{6}$/)
  })

  it('handles empty name', () => {
    const slug = generateAgentSlug('')
    expect(slug).toMatch(/^[a-z0-9]{6}$/)
  })

  it('handles name with only special characters', () => {
    const slug = generateAgentSlug('@#$%^&*()')
    expect(slug).toMatch(/^[a-z0-9]{6}$/)
  })

  it('truncates long names to 50 characters', () => {
    const longName = 'a'.repeat(100)
    const slug = generateAgentSlug(longName)
    // Base should be truncated to 50, plus hyphen and 6-char suffix
    expect(slug.length).toBeLessThanOrEqual(50 + 1 + 6)
  })

  it('generates different slugs for same name (random suffix)', () => {
    const slug1 = generateAgentSlug('Test')
    const slug2 = generateAgentSlug('Test')
    // Very unlikely to be the same due to random suffix
    expect(slug1).not.toBe(slug2)
  })

  it('handles unicode characters', () => {
    const slug = generateAgentSlug('Tëst Àgènt')
    expect(slug).toMatch(/^t-st-g-nt-[a-z0-9]{6}$/)
  })

  it('handles numbers in name', () => {
    const slug = generateAgentSlug('Agent 007')
    expect(slug).toMatch(/^agent-007-[a-z0-9]{6}$/)
  })
})

describe('generateUniqueAgentSlug', () => {
  it('generates a unique slug when no collision', async () => {
    // Mock getDataDir to use our test directory
    vi.mock('@/lib/config/data-dir', () => ({
      getDataDir: () => testDir,
    }))

    // Dynamically re-import to pick up the mock
    const { generateUniqueAgentSlug: genSlug } = await import('./file-storage')
    const slug = await genSlug('Test Agent')
    expect(slug).toMatch(/^test-agent-[a-z0-9]{6}$/)

    vi.resetModules()
  })
})

// ============================================================================
// Frontmatter Parsing Tests
// ============================================================================

describe('parseMarkdownWithFrontmatter', () => {
  it('parses frontmatter and body correctly', () => {
    const content = `---
name: Test Agent
description: A test agent
---

# Hello World

This is the body.`

    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter).toEqual({
      name: 'Test Agent',
      description: 'A test agent',
    })
    expect(result.body).toBe('# Hello World\n\nThis is the body.')
  })

  it('returns empty frontmatter when none present', () => {
    const content = '# Just a body\n\nNo frontmatter here.'
    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(content)
  })

  it('handles empty content', () => {
    const result = parseMarkdownWithFrontmatter('')
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('')
  })

  it('parses boolean values', () => {
    const content = `---
enabled: true
disabled: false
---
body`

    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.enabled).toBe(true)
    expect(result.frontmatter.disabled).toBe(false)
  })

  it('parses numeric values', () => {
    const content = `---
count: 42
price: 19.99
negative: -5
---
body`

    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.count).toBe(42)
    expect(result.frontmatter.price).toBe(19.99)
    expect(result.frontmatter.negative).toBe(-5)
  })

  it('removes surrounding quotes from string values', () => {
    const content = `---
single: 'quoted value'
double: "double quoted"
---
body`

    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.single).toBe('quoted value')
    expect(result.frontmatter.double).toBe('double quoted')
  })

  it('handles values with colons', () => {
    const content = `---
time: 10:30:00
url: https://example.com
---
body`

    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.time).toBe('10:30:00')
    expect(result.frontmatter.url).toBe('https://example.com')
  })

  it('handles Windows-style line endings', () => {
    const content = '---\r\nname: Test\r\n---\r\nBody'
    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.name).toBe('Test')
    expect(result.body).toBe('Body')
  })

  it('handles empty body with frontmatter', () => {
    const content = `---
name: Test
---
`
    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.name).toBe('Test')
    expect(result.body).toBe('')
  })

  it('handles frontmatter without trailing newline', () => {
    const content = `---
name: Test
---
Body content`
    const result = parseMarkdownWithFrontmatter(content)
    expect(result.frontmatter.name).toBe('Test')
    expect(result.body).toBe('Body content')
  })
})

describe('serializeMarkdownWithFrontmatter', () => {
  it('serializes frontmatter and body correctly', () => {
    const frontmatter = { name: 'Test Agent', count: 42 }
    const body = '# Hello\n\nWorld'
    const result = serializeMarkdownWithFrontmatter(frontmatter, body)

    expect(result).toBe(`---
name: Test Agent
count: 42
---

# Hello

World`)
  })

  it('skips null and undefined values', () => {
    const frontmatter = { name: 'Test', empty: null, missing: undefined }
    const body = 'Body'
    const result = serializeMarkdownWithFrontmatter(frontmatter, body)

    expect(result).toBe(`---
name: Test
---

Body`)
  })

  it('quotes strings with special characters', () => {
    const frontmatter = {
      normal: 'simple',
      withColon: 'value: with colon',
      withHash: 'value # with hash',
    }
    const body = 'Body'
    const result = serializeMarkdownWithFrontmatter(frontmatter, body)

    expect(result).toContain('normal: simple')
    expect(result).toContain('withColon: "value: with colon"')
    expect(result).toContain('withHash: "value # with hash"')
  })

  it('quotes strings with newlines', () => {
    const frontmatter = {
      withNewline: 'line1\nline2',
    }
    const body = 'Body'
    const result = serializeMarkdownWithFrontmatter(frontmatter, body)

    // The serializer wraps in quotes but preserves literal newlines
    // This creates a multiline quoted string in YAML
    expect(result).toContain('withNewline: "line1')
    expect(result).toContain('line2"')
  })

  it('handles boolean values', () => {
    const frontmatter = { enabled: true, disabled: false }
    const result = serializeMarkdownWithFrontmatter(frontmatter, 'Body')

    expect(result).toContain('enabled: true')
    expect(result).toContain('disabled: false')
  })

  it('roundtrips correctly with parse', () => {
    const originalFrontmatter = {
      name: 'Test Agent',
      description: 'A description',
      count: 42,
      enabled: true,
    }
    const originalBody = '# Title\n\nContent here.'

    const serialized = serializeMarkdownWithFrontmatter(originalFrontmatter, originalBody)
    const parsed = parseMarkdownWithFrontmatter(serialized)

    expect(parsed.frontmatter).toEqual(originalFrontmatter)
    expect(parsed.body).toBe(originalBody)
  })
})

// ============================================================================
// Directory Operations Tests
// ============================================================================

describe('listDirectories', () => {
  it('lists subdirectories', async () => {
    await fs.promises.mkdir(path.join(testDir, 'dir1'))
    await fs.promises.mkdir(path.join(testDir, 'dir2'))
    await fs.promises.writeFile(path.join(testDir, 'file.txt'), 'content')

    const dirs = await listDirectories(testDir)
    expect(dirs.sort()).toEqual(['dir1', 'dir2'])
  })

  it('returns empty array for empty directory', async () => {
    const dirs = await listDirectories(testDir)
    expect(dirs).toEqual([])
  })

  it('returns empty array for non-existent directory', async () => {
    const dirs = await listDirectories(path.join(testDir, 'nonexistent'))
    expect(dirs).toEqual([])
  })
})

describe('directoryExists', () => {
  it('returns true for existing directory', async () => {
    await fs.promises.mkdir(path.join(testDir, 'subdir'))
    const exists = await directoryExists(path.join(testDir, 'subdir'))
    expect(exists).toBe(true)
  })

  it('returns false for non-existent path', async () => {
    const exists = await directoryExists(path.join(testDir, 'nonexistent'))
    expect(exists).toBe(false)
  })

  it('returns false for file path', async () => {
    await fs.promises.writeFile(path.join(testDir, 'file.txt'), 'content')
    const exists = await directoryExists(path.join(testDir, 'file.txt'))
    expect(exists).toBe(false)
  })
})

describe('fileExists', () => {
  it('returns true for existing file', async () => {
    await fs.promises.writeFile(path.join(testDir, 'file.txt'), 'content')
    const exists = await fileExists(path.join(testDir, 'file.txt'))
    expect(exists).toBe(true)
  })

  it('returns false for non-existent path', async () => {
    const exists = await fileExists(path.join(testDir, 'nonexistent.txt'))
    expect(exists).toBe(false)
  })

  it('returns false for directory path', async () => {
    await fs.promises.mkdir(path.join(testDir, 'subdir'))
    const exists = await fileExists(path.join(testDir, 'subdir'))
    expect(exists).toBe(false)
  })
})

describe('ensureDirectory', () => {
  it('creates directory if not exists', async () => {
    const dirPath = path.join(testDir, 'new-dir')
    await ensureDirectory(dirPath)
    const exists = await directoryExists(dirPath)
    expect(exists).toBe(true)
  })

  it('creates nested directories', async () => {
    const dirPath = path.join(testDir, 'a', 'b', 'c')
    await ensureDirectory(dirPath)
    const exists = await directoryExists(dirPath)
    expect(exists).toBe(true)
  })

  it('does not throw if directory already exists', async () => {
    const dirPath = path.join(testDir, 'existing')
    await fs.promises.mkdir(dirPath)
    await expect(ensureDirectory(dirPath)).resolves.toBeUndefined()
  })
})

describe('removeDirectory', () => {
  it('removes directory and contents', async () => {
    const dirPath = path.join(testDir, 'to-remove')
    await fs.promises.mkdir(dirPath)
    await fs.promises.writeFile(path.join(dirPath, 'file.txt'), 'content')

    await removeDirectory(dirPath)
    const exists = await directoryExists(dirPath)
    expect(exists).toBe(false)
  })

  it('removes nested directories', async () => {
    const dirPath = path.join(testDir, 'nested')
    await fs.promises.mkdir(path.join(dirPath, 'a', 'b'), { recursive: true })
    await fs.promises.writeFile(path.join(dirPath, 'a', 'b', 'file.txt'), 'content')

    await removeDirectory(dirPath)
    const exists = await directoryExists(dirPath)
    expect(exists).toBe(false)
  })

  it('does not throw if directory does not exist', async () => {
    const dirPath = path.join(testDir, 'nonexistent')
    await expect(removeDirectory(dirPath)).resolves.toBeUndefined()
  })
})

// ============================================================================
// File Operations Tests
// ============================================================================

describe('readFileOrNull', () => {
  it('reads existing file content', async () => {
    const filePath = path.join(testDir, 'test.txt')
    await fs.promises.writeFile(filePath, 'Hello World')

    const content = await readFileOrNull(filePath)
    expect(content).toBe('Hello World')
  })

  it('returns null for non-existent file', async () => {
    const content = await readFileOrNull(path.join(testDir, 'nonexistent.txt'))
    expect(content).toBeNull()
  })

  it('reads UTF-8 content correctly', async () => {
    const filePath = path.join(testDir, 'unicode.txt')
    await fs.promises.writeFile(filePath, '你好世界 🌍')

    const content = await readFileOrNull(filePath)
    expect(content).toBe('你好世界 🌍')
  })
})

describe('writeFile', () => {
  it('writes content to file', async () => {
    const filePath = path.join(testDir, 'output.txt')
    await writeFile(filePath, 'Test content')

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('Test content')
  })

  it('overwrites existing file', async () => {
    const filePath = path.join(testDir, 'overwrite.txt')
    await fs.promises.writeFile(filePath, 'Old content')
    await writeFile(filePath, 'New content')

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('New content')
  })

  it('writes with specified mode', async () => {
    const filePath = path.join(testDir, 'secret.txt')
    await writeFile(filePath, 'secret', { mode: 0o600 })

    const stats = await fs.promises.stat(filePath)
    // Check owner read/write only (0o600 = -rw-------)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})

// ============================================================================
// JSONL Operations Tests
// ============================================================================

describe('parseJsonl', () => {
  it('parses JSONL content into array', () => {
    const content = `{"id": 1, "name": "first"}
{"id": 2, "name": "second"}
{"id": 3, "name": "third"}`

    const result = parseJsonl<{ id: number; name: string }>(content)
    expect(result).toEqual([
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
      { id: 3, name: 'third' },
    ])
  })

  it('skips empty lines', () => {
    const content = `{"id": 1}

{"id": 2}

`
    const result = parseJsonl(content)
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('handles Windows line endings', () => {
    const content = '{"id": 1}\r\n{"id": 2}\r\n'
    const result = parseJsonl(content)
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('skips malformed lines', () => {
    const content = `{"id": 1}
not valid json
{"id": 2}`

    const result = parseJsonl(content)
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns empty array for empty content', () => {
    const result = parseJsonl('')
    expect(result).toEqual([])
  })

  it('handles complex nested objects', () => {
    const content = `{"nested": {"array": [1, 2, 3], "obj": {"key": "value"}}}`
    const result = parseJsonl(content)
    expect(result).toEqual([
      { nested: { array: [1, 2, 3], obj: { key: 'value' } } },
    ])
  })
})

describe('readJsonlFile', () => {
  it('reads and parses JSONL file', async () => {
    const filePath = path.join(testDir, 'data.jsonl')
    await fs.promises.writeFile(
      filePath,
      '{"id": 1}\n{"id": 2}\n{"id": 3}'
    )

    const result = await readJsonlFile<{ id: number }>(filePath)
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('returns empty array for non-existent file', async () => {
    const result = await readJsonlFile(path.join(testDir, 'nonexistent.jsonl'))
    expect(result).toEqual([])
  })
})

describe('streamJsonlFile', () => {
  it('streams JSONL file line by line', async () => {
    const filePath = path.join(testDir, 'stream.jsonl')
    await fs.promises.writeFile(
      filePath,
      '{"id": 1}\n{"id": 2}\n{"id": 3}'
    )

    const results: { id: number }[] = []
    for await (const item of streamJsonlFile<{ id: number }>(filePath)) {
      results.push(item)
    }

    expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('handles large files with chunked reading', async () => {
    const filePath = path.join(testDir, 'large.jsonl')

    // Create a file with many lines
    const lines = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ id: i, data: 'x'.repeat(100) })
    ).join('\n')
    await fs.promises.writeFile(filePath, lines)

    const results: { id: number }[] = []
    for await (const item of streamJsonlFile<{ id: number; data: string }>(filePath)) {
      results.push({ id: item.id })
    }

    expect(results.length).toBe(1000)
    expect(results[0].id).toBe(0)
    expect(results[999].id).toBe(999)
  })

  it('skips malformed lines while streaming', async () => {
    const filePath = path.join(testDir, 'malformed.jsonl')
    await fs.promises.writeFile(
      filePath,
      '{"id": 1}\ninvalid json\n{"id": 2}'
    )

    const results: { id: number }[] = []
    for await (const item of streamJsonlFile<{ id: number }>(filePath)) {
      results.push(item)
    }

    expect(results).toEqual([{ id: 1 }, { id: 2 }])
  })
})

// ============================================================================
// Agent Path Helper Tests
// ============================================================================

describe('path helpers', () => {
  // Mock getDataDir for consistent test results
  beforeEach(() => {
    vi.mock('@/lib/config/data-dir', () => ({
      getDataDir: () => '/mock/data',
    }))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('getAgentsDir returns correct path', async () => {
    const { getAgentsDir } = await import('./file-storage')
    expect(getAgentsDir()).toBe('/mock/data/agents')
  })

  it('getAgentDir returns correct path', async () => {
    const { getAgentDir } = await import('./file-storage')
    expect(getAgentDir('my-agent')).toBe('/mock/data/agents/my-agent')
  })

  it('getAgentWorkspaceDir returns correct path', async () => {
    const { getAgentWorkspaceDir } = await import('./file-storage')
    expect(getAgentWorkspaceDir('my-agent')).toBe('/mock/data/agents/my-agent/workspace')
  })

  it('getAgentClaudeMdPath returns correct path', async () => {
    const { getAgentClaudeMdPath } = await import('./file-storage')
    expect(getAgentClaudeMdPath('my-agent')).toBe('/mock/data/agents/my-agent/workspace/CLAUDE.md')
  })

  it('getAgentEnvPath returns correct path', async () => {
    const { getAgentEnvPath } = await import('./file-storage')
    expect(getAgentEnvPath('my-agent')).toBe('/mock/data/agents/my-agent/workspace/.env')
  })

  it('getAgentSessionMetadataPath returns correct path', async () => {
    const { getAgentSessionMetadataPath } = await import('./file-storage')
    expect(getAgentSessionMetadataPath('my-agent')).toBe('/mock/data/agents/my-agent/workspace/session-metadata.json')
  })

  it('getAgentClaudeConfigDir returns correct path', async () => {
    const { getAgentClaudeConfigDir } = await import('./file-storage')
    expect(getAgentClaudeConfigDir('my-agent')).toBe('/mock/data/agents/my-agent/workspace/.claude')
  })

  it('getAgentSessionsDir returns correct path', async () => {
    const { getAgentSessionsDir } = await import('./file-storage')
    expect(getAgentSessionsDir('my-agent')).toBe('/mock/data/agents/my-agent/workspace/.claude/projects/-workspace')
  })

  it('getSessionJsonlPath returns correct path', async () => {
    const { getSessionJsonlPath } = await import('./file-storage')
    expect(getSessionJsonlPath('my-agent', 'session-123')).toBe(
      '/mock/data/agents/my-agent/workspace/.claude/projects/-workspace/session-123.jsonl'
    )
  })
})
