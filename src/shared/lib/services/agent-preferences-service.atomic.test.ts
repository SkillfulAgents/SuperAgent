/**
 * agent-preferences.json hardening: serialized + atomic writes, and
 * never persist a `{}` synthesized from a parse error (which would drop all prefs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { updateAgentPreferences, readAgentPreferences } from './agent-preferences-service'

let tmpDir: string

function prefsPath(slug: string): string {
  return path.join(tmpDir, 'agents', slug, 'workspace', 'agent-preferences.json')
}
function makeAgent(slug: string): void {
  fs.mkdirSync(path.dirname(prefsPath(slug)), { recursive: true })
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prefs-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

describe('fail-closed + atomic agent preferences', () => {
  it('update on a CORRUPT file THROWS and does NOT overwrite it with the merged value', async () => {
    makeAgent('agent')
    const corrupt = '{ "autoDeleteInactiveDays": 3'
    fs.writeFileSync(prefsPath('agent'), corrupt)

    await expect(updateAgentPreferences('agent', { autoDeleteInactiveDays: 90 })).rejects.toThrow()
    // The corrupt bytes survive — NOT replaced by `{ autoDeleteInactiveDays: 90 }`.
    expect(fs.readFileSync(prefsPath('agent'), 'utf-8')).toBe(corrupt)
  })

  it('writes atomically (no temp file left behind)', async () => {
    makeAgent('agent')
    await updateAgentPreferences('agent', { autoDeleteInactiveDays: 30 })
    const dir = path.dirname(prefsPath('agent'))
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('serialized concurrent updates leave a valid, parseable file', async () => {
    makeAgent('agent')
    await updateAgentPreferences('agent', { autoDeleteInactiveDays: 10 })

    await Promise.all([
      updateAgentPreferences('agent', { autoDeleteInactiveDays: 20 }),
      updateAgentPreferences('agent', { autoDeleteInactiveDays: 30 }),
      updateAgentPreferences('agent', { autoDeleteInactiveDays: 40 }),
    ])

    // File is intact (no torn write) and holds one of the written values.
    const onDisk = JSON.parse(fs.readFileSync(prefsPath('agent'), 'utf-8'))
    expect([20, 30, 40]).toContain(onDisk.autoDeleteInactiveDays)
    expect(await readAgentPreferences('agent')).toEqual(onDisk)
  })
})
