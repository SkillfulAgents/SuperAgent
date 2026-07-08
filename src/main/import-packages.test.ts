import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@shared/lib/services/agent-template-service', () => ({
  validateAgentTemplate: vi.fn(),
  MAX_COMPRESSED_SIZE: 1024, // tiny caps so tests can trip them with real files
}))
vi.mock('@shared/lib/services/skillset-service', () => ({
  validateSkillZip: vi.fn(),
  SKILL_MAX_COMPRESSED_SIZE: 128,
}))

import { classifyImportPackage } from './import-packages'
import { validateAgentTemplate } from '@shared/lib/services/agent-template-service'
import { validateSkillZip } from '@shared/lib/services/skillset-service'

const templateValid = { valid: true, agentName: 'Researcher', fileCount: 3, stripPrefix: '' }
const templateInvalid = { valid: false, error: 'CLAUDE.md not found in template', fileCount: 1, stripPrefix: '' }
const skillValid = { valid: true, skillName: 'pdf-tools', fileCount: 2, stripPrefix: '' }
const skillInvalid = { valid: false, error: 'SKILL.md not found in package', fileCount: 1, stripPrefix: '' }

describe('classifyImportPackage', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-packages-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writePackage(name: string, bytes = 16): string {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, Buffer.alloc(bytes, 1))
    return filePath
  }

  it('classifies an agent template and reports its frontmatter name', async () => {
    vi.mocked(validateAgentTemplate).mockResolvedValue(templateValid)

    const result = await classifyImportPackage(writePackage('researcher.agent'))

    expect(result).toEqual({
      path: path.join(tmpDir, 'researcher.agent'),
      fileName: 'researcher.agent',
      kind: 'agent-template',
      name: 'Researcher',
    })
    expect(validateSkillZip).not.toHaveBeenCalled()
  })

  it('routes by content, not extension: a skill renamed .agent classifies as a skill', async () => {
    vi.mocked(validateAgentTemplate).mockResolvedValue(templateInvalid)
    vi.mocked(validateSkillZip).mockResolvedValue(skillValid)

    const result = await classifyImportPackage(writePackage('renamed.agent'))

    expect(result).toMatchObject({ kind: 'skill', name: 'pdf-tools' })
  })

  it('tries the skill validator first for .skill files, so their diagnostics win', async () => {
    vi.mocked(validateAgentTemplate).mockResolvedValue(templateInvalid)
    vi.mocked(validateSkillZip).mockResolvedValue({ ...skillInvalid, error: 'Invalid path in package: ../evil' })

    const result = await classifyImportPackage(writePackage('broken.skill'))

    expect(result).toMatchObject({ error: expect.stringContaining('Invalid path in package: ../evil') })
    expect(result).not.toMatchObject({ error: expect.stringContaining('CLAUDE.md') })
    // Extension also breaks both-marker ties: skill validation ran before template.
    expect(vi.mocked(validateSkillZip).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(validateAgentTemplate).mock.invocationCallOrder[0])
  })

  it('rejects files over the template cap before reading or validating', async () => {
    const result = await classifyImportPackage(writePackage('huge.agent', 2048))

    expect(result).toMatchObject({ error: expect.stringContaining(`max ${1024 / 1024 / 1024}MB`) })
    expect(validateAgentTemplate).not.toHaveBeenCalled()
    expect(validateSkillZip).not.toHaveBeenCalled()
  })

  it('quotes the skill cap (not the template cap) when an over-everything .skill is rejected', async () => {
    const result = await classifyImportPackage(writePackage('huge.skill', 2048))

    expect(result).toMatchObject({ error: expect.stringContaining(`max ${128 / 1024 / 1024}MB`) })
    expect(validateSkillZip).not.toHaveBeenCalled()
  })

  it('rejects an over-cap .skill without paying for skill zip validation', async () => {
    vi.mocked(validateAgentTemplate).mockResolvedValue(templateInvalid)

    const result = await classifyImportPackage(writePackage('big.skill', 512))

    expect(result).toMatchObject({ error: expect.stringContaining('Skill packages are limited to') })
    expect(validateSkillZip).not.toHaveBeenCalled()
  })

  it('still classifies an agent template renamed .skill even when it exceeds the skill cap', async () => {
    vi.mocked(validateAgentTemplate).mockResolvedValue(templateValid)

    const result = await classifyImportPackage(writePackage('renamed-template.skill', 512))

    expect(result).toMatchObject({ kind: 'agent-template', name: 'Researcher' })
    expect(validateSkillZip).not.toHaveBeenCalled()
  })

  it('returns an error result for an unreadable path instead of throwing', async () => {
    const result = await classifyImportPackage(path.join(tmpDir, 'missing.agent'))

    expect(result).toMatchObject({ fileName: 'missing.agent', error: expect.any(String) })
  })
})
