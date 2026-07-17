import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  nameToSlugBase,
  generateAgentId,
  displaySlug,
  resolveAgentId,
  isMintedAgentId,
  AGENT_ID_LENGTH,
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
  readAgentDisplayNameSync,
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

describe('nameToSlugBase', () => {
  it('lowercases and hyphenates a name', () => {
    expect(nameToSlugBase('My Cool Agent')).toBe('my-cool-agent')
  })

  it('collapses runs of special characters to single hyphens and trims edges', () => {
    expect(nameToSlugBase('Test @#$ Agent!!!')).toBe('test-agent')
    expect(nameToSlugBase('---Test---')).toBe('test')
    expect(nameToSlugBase('Tëst Àgènt')).toBe('t-st-g-nt')
  })

  it('keeps digits and only ever emits [a-z0-9-]', () => {
    expect(nameToSlugBase('GPT 4 Bot')).toBe('gpt-4-bot')
    expect(nameToSlugBase('Agent 007')).toBe('agent-007')
  })

  it('returns an empty string when nothing alphanumeric survives', () => {
    expect(nameToSlugBase('')).toBe('')
    expect(nameToSlugBase('@#$%^&*()')).toBe('')
  })

  it('truncates the base to 50 characters', () => {
    expect(nameToSlugBase('a'.repeat(100))).toHaveLength(50)
  })
})

describe('isMintedAgentId', () => {
  it('accepts a bare 10-char [a-z0-9] id', () => {
    expect(isMintedAgentId('k7x9m2ab3c')).toBe(true)
  })

  it('rejects legacy / wrong-length / out-of-charset strings', () => {
    expect(isMintedAgentId('abc123')).toBe(false) // 6-char legacy suffix
    expect(isMintedAgentId('untitled-h45k3n')).toBe(false) // legacy compound
    expect(isMintedAgentId('k7x9m2ab3')).toBe(false) // 9 chars
    expect(isMintedAgentId('K7X9M2AB3C')).toBe(false) // uppercase
    expect(isMintedAgentId('')).toBe(false)
  })
})

describe('displaySlug', () => {
  const id = 'k7x9m2ab3c' // 10-char minted id

  it('projects {base}-{id} for a named, minted agent', () => {
    expect(displaySlug('GPT 4 Bot', id)).toBe(`gpt-4-bot-${id}`)
  })

  it('returns the bare id when the name slugifies to empty', () => {
    expect(displaySlug('', id)).toBe(id)
    expect(displaySlug('🙂', id)).toBe(id)
  })

  it('returns legacy folder ids verbatim — never re-prettified (would break resolution)', () => {
    expect(displaySlug('Renamed Agent', 'untitled-h45k3n')).toBe('untitled-h45k3n')
    expect(displaySlug('Renamed Agent', 'abc123')).toBe('abc123')
  })
})

describe('readAgentDisplayNameSync', () => {
  let prevDataDir: string | undefined

  beforeEach(async () => {
    prevDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    await ensureDirectory(getAgentsDir())
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  const writeClaudeMd = async (slug: string, frontmatterName: string) => {
    await ensureDirectory(getAgentWorkspaceDir(slug))
    await writeFile(getAgentClaudeMdPath(slug), `---\nname: ${frontmatterName}\n---\nBody`)
  }

  it('reads the display name from frontmatter', async () => {
    await writeClaudeMd('agent1', 'My Agent')
    expect(readAgentDisplayNameSync('agent1')).toBe('My Agent')
  })

  it('coerces YAML-ambiguous names the parser turned into number/boolean', async () => {
    await writeClaudeMd('agent2', '123')
    expect(readAgentDisplayNameSync('agent2')).toBe('123')
    await writeClaudeMd('agent3', 'true')
    expect(readAgentDisplayNameSync('agent3')).toBe('true')
  })

  it('returns undefined when the file or name is missing', async () => {
    expect(readAgentDisplayNameSync('nonexistent')).toBeUndefined()
    await ensureDirectory(getAgentWorkspaceDir('agent4'))
    await writeFile(getAgentClaudeMdPath('agent4'), '---\ndescription: no name\n---\nBody')
    expect(readAgentDisplayNameSync('agent4')).toBeUndefined()
  })
})

describe('generateAgentId + resolveAgentId (filesystem-backed)', () => {
  // Point the data dir at the per-test temp dir so getAgentDir() lands there.
  let prevDataDir: string | undefined

  beforeEach(async () => {
    prevDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    await ensureDirectory(getAgentsDir())
  })

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  const makeAgentFolder = (id: string) => ensureDirectory(getAgentDir(id))

  it('mints a bare [a-z0-9]{10} id, not derived from any name', async () => {
    const id = await generateAgentId()
    expect(id).toMatch(new RegExp(`^[a-z0-9]{${AGENT_ID_LENGTH}}$`))
  })

  it('mints distinct ids across calls', async () => {
    expect(await generateAgentId()).not.toBe(await generateAgentId())
  })

  it('resolves a bare minted id (exact folder match)', async () => {
    const id = await generateAgentId()
    await makeAgentFolder(id)
    expect(await resolveAgentId(id)).toBe(id)
  })

  it('resolves a {name}-{id} display slug to the id', async () => {
    const id = await generateAgentId()
    await makeAgentFolder(id)
    expect(await resolveAgentId(`gpt-4-bot-${id}`)).toBe(id)
  })

  it('resolves a wrong-prefix {anything}-{id} to the same id (prefix is decorative)', async () => {
    const id = await generateAgentId()
    await makeAgentFolder(id)
    expect(await resolveAgentId(`literally-anything-${id}`)).toBe(id)
    expect(await resolveAgentId(`beta-${id}`)).toBe(id)
  })

  it('resolves a legacy compound folder id to itself', async () => {
    await makeAgentFolder('untitled-h45k3n')
    expect(await resolveAgentId('untitled-h45k3n')).toBe('untitled-h45k3n')
  })

  it('resolves a bare legacy id to itself', async () => {
    await makeAgentFolder('abc123')
    expect(await resolveAgentId('abc123')).toBe('abc123')
  })

  it('returns null for an unknown slug', async () => {
    expect(await resolveAgentId('does-not-exist')).toBeNull()
  })

  it('returns null for a well-formed but non-existent minted id', async () => {
    expect(await resolveAgentId('zzzzzzzzzz')).toBeNull()
  })

  it.each(['../foo', 'a/b', 'a_b', '..', '.', 'foo/../bar', 'UPPER', ''])(
    'rejects unsafe / out-of-charset input %j with no filesystem access',
    async (bad) => {
      expect(await resolveAgentId(bad)).toBeNull()
    },
  )
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
  // These tests verify the path helper functions build correct paths
  // We use the actual getDataDir since the paths are relative to it

  it('getAgentsDir returns path ending with /agents', () => {
    expect(getAgentsDir()).toMatch(/\/agents$/)
  })

  it('getAgentDir returns path ending with agent slug', () => {
    expect(getAgentDir('my-agent')).toMatch(/\/agents\/my-agent$/)
  })

  it('getAgentWorkspaceDir returns path ending with workspace', () => {
    expect(getAgentWorkspaceDir('my-agent')).toMatch(/\/agents\/my-agent\/workspace$/)
  })

  it('getAgentClaudeMdPath returns path ending with CLAUDE.md', () => {
    expect(getAgentClaudeMdPath('my-agent')).toMatch(/\/agents\/my-agent\/workspace\/CLAUDE\.md$/)
  })

  it('getAgentEnvPath returns path ending with .env', () => {
    expect(getAgentEnvPath('my-agent')).toMatch(/\/agents\/my-agent\/workspace\/\.env$/)
  })

  it('getAgentSessionMetadataPath returns path ending with session-metadata.json', () => {
    expect(getAgentSessionMetadataPath('my-agent')).toMatch(/\/agents\/my-agent\/workspace\/session-metadata\.json$/)
  })

  it('getAgentClaudeConfigDir returns path ending with .claude', () => {
    expect(getAgentClaudeConfigDir('my-agent')).toMatch(/\/agents\/my-agent\/workspace\/\.claude$/)
  })

  it('getAgentSessionsDir returns path ending with projects/-workspace', () => {
    expect(getAgentSessionsDir('my-agent')).toMatch(/\/agents\/my-agent\/workspace\/\.claude\/projects\/-workspace$/)
  })

  it('getSessionJsonlPath returns path ending with session jsonl file', () => {
    expect(getSessionJsonlPath('my-agent', 'session-123')).toMatch(
      /\/agents\/my-agent\/workspace\/\.claude\/projects\/-workspace\/session-123\.jsonl$/
    )
  })

  it('getSessionJsonlPath rejects session ids that escape the sessions directory', () => {
    expect(() => getSessionJsonlPath('my-agent', '../outside')).toThrow('Invalid session ID')
    expect(() => getSessionJsonlPath('my-agent', '/tmp/outside')).toThrow('Invalid session ID')
  })
})
