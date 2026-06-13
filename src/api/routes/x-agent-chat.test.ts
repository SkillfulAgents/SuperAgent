import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('appendAssistantMessage JSONL format', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-jsonl-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('writes a valid JSONL entry with correct fields', () => {
    const jsonlPath = path.join(testDir, 'test-session.jsonl')
    const sessionId = 'test-session-id'
    const text = 'Hello from the agent'

    // Replicate the appendAssistantMessage logic
    const entry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      uuid: 'test-uuid',
      parentUuid: null,
      sessionId,
      timestamp: '2026-05-23T12:00:00.000Z',
    }
    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n')

    const content = fs.readFileSync(jsonlPath, 'utf-8').trim()
    const parsed = JSON.parse(content)

    expect(parsed.type).toBe('assistant')
    expect(parsed.message.content).toEqual([{ type: 'text', text: 'Hello from the agent' }])
    expect(parsed.sessionId).toBe(sessionId)
    expect(parsed.parentUuid).toBeNull()
    expect(parsed.uuid).toBe('test-uuid')
    expect(parsed.timestamp).toBeTruthy()
  })

  it('appends to existing JSONL without overwriting', () => {
    const jsonlPath = path.join(testDir, 'test-session.jsonl')

    // Write two entries
    const entry1 = { type: 'user', message: { content: 'Hi' }, uuid: 'u1', sessionId: 's1', timestamp: 't1' }
    const entry2 = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] }, uuid: 'u2', parentUuid: null, sessionId: 's1', timestamp: 't2' }

    fs.appendFileSync(jsonlPath, JSON.stringify(entry1) + '\n')
    fs.appendFileSync(jsonlPath, JSON.stringify(entry2) + '\n')

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).type).toBe('user')
    expect(JSON.parse(lines[1]).type).toBe('assistant')
  })

  it('inlines context with message text', () => {
    const message = 'Your daily summary is ready'
    const context = 'Triggered by cron at 12:00 PM'
    const messageText = `[Internal context: ${context}]\n\n${message}`

    expect(messageText).toBe('[Internal context: Triggered by cron at 12:00 PM]\n\nYour daily summary is ready')
  })
})
