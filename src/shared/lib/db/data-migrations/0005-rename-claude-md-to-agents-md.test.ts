import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '../testing/create-test-database'
import { agents } from '../schema'
import { renameAgentInstructions } from './0005-rename-claude-md-to-agents-md'

let handle: TestDatabase
let dataDir: string

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'agents-md-migration-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function addAgent(slug: string, files: Record<string, string>): Promise<string> {
  await handle.db.insert(agents).values({ slug, name: slug, createdAt: new Date(), runtime: 'local', workspaceHandle: null }).run()
  const workspace = path.join(dataDir, 'agents', slug, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), content)
  return workspace
}

const read = (workspace: string, name: string) => fs.readFileSync(path.join(workspace, name), 'utf-8')
const exists = (workspace: string, name: string) => fs.existsSync(path.join(workspace, name))

describe('rename-claude-md-to-agents-md', () => {
  it('moves CLAUDE.md to AGENTS.md, and leaves an agent that has an AGENTS.md or neither alone', async () => {
    const renamed = await addAgent('renamed', { 'CLAUDE.md': 'claude\n' })
    const both = await addAgent('both', { 'CLAUDE.md': 'claude\n', 'AGENTS.md': 'agents\n' })
    const already = await addAgent('already', { 'AGENTS.md': 'agents\n' })
    await addAgent('empty', {})

    expect(await renameAgentInstructions(handle.db)).toEqual(['renamed'])

    expect(exists(renamed, 'CLAUDE.md')).toBe(false)
    expect(read(renamed, 'AGENTS.md')).toBe('claude\n')
    expect(read(both, 'CLAUDE.md')).toBe('claude\n')
    expect(read(both, 'AGENTS.md')).toBe('agents\n')
    expect(read(already, 'AGENTS.md')).toBe('agents\n')

    expect(await renameAgentInstructions(handle.db)).toEqual([])
  })
})
