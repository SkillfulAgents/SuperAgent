import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { appendInformationalEntry } from './session-transcript-append'

describe('appendInformationalEntry', () => {
  let testDir: string
  let originalEnv: string | undefined
  let sessionsDir: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-append-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    sessionsDir = path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'projects', '-workspace')
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  function jsonlPath(sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.jsonl`)
  }

  async function readLines(sessionId: string): Promise<string[]> {
    const content = await fs.promises.readFile(jsonlPath(sessionId), 'utf-8')
    return content.split('\n').filter((l) => l.trim())
  }

  function transcriptLine(uuid: string, padding = 0): string {
    return JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content: padding > 0 ? 'x'.repeat(padding) : 'hello' },
    })
  }

  it('creates the file (and parent dirs) when the transcript does not exist yet', async () => {
    await appendInformationalEntry('test-agent', 'sess-1', {
      uuid: 'info-1',
      content: 'prompt blocked',
      level: 'warning',
    })

    const lines = await readLines('sess-1')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({
      uuid: 'info-1',
      type: 'system',
      subtype: 'informational',
      content: 'prompt blocked',
      level: 'warning',
      isMeta: false,
    })
  })

  it('appends to an empty existing file', async () => {
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    await fs.promises.writeFile(jsonlPath('sess-1'), '')

    await appendInformationalEntry('test-agent', 'sess-1', { uuid: 'info-1', content: 'note' })
    expect((await readLines('sess-1')).length).toBe(1)
  })

  it('appends when the uuid is absent from the transcript', async () => {
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    await fs.promises.writeFile(jsonlPath('sess-1'), transcriptLine('other-uuid') + '\n')

    await appendInformationalEntry('test-agent', 'sess-1', { uuid: 'info-1', content: 'note' })

    const lines = await readLines('sess-1')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[1]).uuid).toBe('info-1')
  })

  it('skips a duplicate uuid in a file smaller than the scan window', async () => {
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    const original = transcriptLine('info-1') + '\n'
    await fs.promises.writeFile(jsonlPath('sess-1'), original)

    await appendInformationalEntry('test-agent', 'sess-1', { uuid: 'info-1', content: 'dupe' })

    expect(await fs.promises.readFile(jsonlPath('sess-1'), 'utf-8')).toBe(original)
  })

  it('skips a duplicate uuid found within the tail window of a large file', async () => {
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    // > 1MB of padding first, duplicate uuid near the end (inside the window)
    const content =
      transcriptLine('old-entry', 1_200_000) + '\n' + transcriptLine('info-1') + '\n'
    await fs.promises.writeFile(jsonlPath('sess-1'), content)

    await appendInformationalEntry('test-agent', 'sess-1', { uuid: 'info-1', content: 'dupe' })

    expect((await readLines('sess-1')).length).toBe(2)
  })

  it('re-appends a duplicate uuid that lies entirely outside the tail scan window (deliberate trade)', async () => {
    // The dedup exists for near-in-time double-delivery (hook replay,
    // late-join replay), which always lands within the tail window. Bounding
    // the scan means a duplicate OLDER than the window is no longer detected —
    // this test pins that accepted behavior change (previously the whole file
    // was read and this would have been skipped).
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    const content =
      transcriptLine('info-1') + '\n' + transcriptLine('padding-entry', 1_500_000) + '\n'
    await fs.promises.writeFile(jsonlPath('sess-1'), content)

    await appendInformationalEntry('test-agent', 'sess-1', { uuid: 'info-1', content: 'dupe' })

    const lines = await readLines('sess-1')
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[2]).uuid).toBe('info-1')
  })
})
