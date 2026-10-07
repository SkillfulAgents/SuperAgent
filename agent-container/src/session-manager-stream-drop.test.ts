import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('./browser-state', () => ({ releaseBrowserLock: () => false }))
vi.mock('./session-persistence', () => ({
  SessionPersistence: class {
    saveSession() {}
    getSession() { return null }
    deleteSession() {}
    updateLastActivity() {}
    updateSession() {}
  },
}))

class MockClaudeProcess extends EventEmitter {
  running = false
  constructor(private readonly options: { sessionId: string }) {
    super()
  }
  async start(): Promise<void> {
    this.running = true
    this.emit('query-start')
  }
  async sendMessage(): Promise<void> {
    this.running = true
    this.emit('claude-session-id', this.options.sessionId)
    this.emit('init-complete')
  }
  async stop(): Promise<void> { this.running = false }
  async dispose(): Promise<void> { this.running = false }
  isRunning(): boolean { return this.running }
  get slashCommands() { return [] }
}

const spawned: MockClaudeProcess[] = []
vi.mock('./claude-code', () => ({
  ClaudeCodeProcess: class {
    constructor(options: { sessionId: string }) {
      const proc = new MockClaudeProcess(options)
      spawned.push(proc)
      return proc
    }
  },
}))

import { SessionManager, type UndeliveredTurnReport } from './session-manager'

const GRACE_MS = 20
const droppedSocket = { code: 1006, reason: '', socketAgeMs: 900_000, idleMsBeforeClose: 120_000, socketError: 'ECONNRESET' }
const pastGrace = () => new Promise((resolve) => setTimeout(resolve, GRACE_MS + 20))

describe('SessionManager undelivered turn report', () => {
  let manager: SessionManager
  let workDir: string
  let reports: UndeliveredTurnReport[]

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-stream-drop-'))
    spawned.length = 0
    manager = new SessionManager(workDir, { prewarmEnabled: false, undeliveredTurnGraceMs: GRACE_MS })
    reports = []
    manager.on('undelivered-turn', (report: UndeliveredTurnReport) => reports.push(report))
  })

  afterEach(async () => {
    await manager.stopAll()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  async function startTurn() {
    const session = await manager.createSession({ initialMessage: 'Summarize the report' })
    return { id: session.id, proc: spawned[spawned.length - 1] }
  }

  const endTurn = (proc: MockClaudeProcess) => proc.emit('message', { type: 'result', subtype: 'success' })
  const settle = (proc: MockClaudeProcess) => proc.emit('message', { type: 'system', subtype: 'session_state_changed', state: 'idle' })

  it('reports a turn that ends after the only subscriber dropped mid-turn', async () => {
    const { id, proc } = await startTurn()
    const unsubscribe = manager.subscribe(id, () => {})
    unsubscribe()
    manager.noteStreamClosed(id, droppedSocket)

    endTurn(proc)
    settle(proc)
    expect(reports).toEqual([])
    await pastGrace()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      sessionId: id,
      resultSubtype: 'success',
      closeCode: 1006,
      closeReason: '',
      socketAgeMs: 900_000,
      idleMsBeforeClose: 120_000,
      socketError: 'ECONNRESET',
    })
    expect(reports[0].msSinceClose).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(reports[0].closedAt))).toBe(false)

    endTurn(proc)
    settle(proc)
    await pastGrace()
    expect(reports).toHaveLength(1)
  })

  it('does not report when the host reconnects after the turn ended but within the grace window', async () => {
    const { id, proc } = await startTurn()
    manager.subscribe(id, () => {})()
    manager.noteStreamClosed(id, droppedSocket)

    endTurn(proc)
    manager.subscribe(id, () => {})
    await pastGrace()

    expect(reports).toEqual([])
  })

  it('does not report when a subscriber reattached before the turn ended', async () => {
    const { id, proc } = await startTurn()
    manager.subscribe(id, () => {})()
    manager.noteStreamClosed(id, droppedSocket)
    manager.subscribe(id, () => {})

    endTurn(proc)
    await pastGrace()

    expect(reports).toEqual([])
  })

  it('does not report a turn that ended before any subscriber attached', async () => {
    const { proc } = await startTurn()

    endTurn(proc)
    await pastGrace()

    expect(reports).toEqual([])
  })

  it('reports a drop between the result and the final idle', async () => {
    const { id, proc } = await startTurn()
    const unsubscribe = manager.subscribe(id, () => {})
    endTurn(proc)
    unsubscribe()
    manager.noteStreamClosed(id, droppedSocket)

    settle(proc)
    await pastGrace()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ sessionId: id, resultSubtype: 'success', closeCode: 1006 })
  })

  it('reports a drop while the query is restarting mid-turn', async () => {
    const { id, proc } = await startTurn()
    manager.subscribe(id, () => {})()
    proc.running = false
    manager.noteStreamClosed(id, droppedSocket)

    proc.running = true
    endTurn(proc)
    settle(proc)
    await pastGrace()

    expect(reports).toHaveLength(1)
  })

  it('does not treat a stale idle before the result as the end of the turn', async () => {
    const { id, proc } = await startTurn()
    manager.subscribe(id, () => {})()
    manager.noteStreamClosed(id, droppedSocket)

    settle(proc)
    await pastGrace()
    expect(reports).toEqual([])

    endTurn(proc)
    settle(proc)
    await pastGrace()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ sessionId: id, resultSubtype: 'success' })
  })

  it('does not treat a result before the final idle as the end of the turn', async () => {
    const { id, proc } = await startTurn()
    manager.subscribe(id, () => {})()
    manager.noteStreamClosed(id, droppedSocket)

    endTurn(proc)
    await pastGrace()
    expect(reports).toEqual([])

    settle(proc)
    await pastGrace()
    expect(reports).toHaveLength(1)
  })

  it('does not report when the stream closed after the turn settled', async () => {
    const { id, proc } = await startTurn()
    const unsubscribe = manager.subscribe(id, () => {})
    endTurn(proc)
    settle(proc)
    unsubscribe()
    manager.noteStreamClosed(id, { ...droppedSocket, code: 1000, reason: 'host detached' })

    endTurn(proc)
    settle(proc)
    await pastGrace()

    expect(reports).toEqual([])
  })
})
