import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tabManager } from './tab-manager'

/** A stand-in for the agent-browser daemon's socket: records each command, answers as `answer` says. */
function fakeDaemon(dir: string, answer: (command: Record<string, unknown>) => Record<string, unknown>) {
  const commands: Array<Record<string, unknown>> = []
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const command = JSON.parse(chunk.toString()) as Record<string, unknown>
      commands.push(command)
      socket.end(JSON.stringify(answer(command)))
    })
  })
  const listening = new Promise<void>((resolve) => server.listen(path.join(dir, 'default.sock'), resolve))
  return { commands, listening, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const TABS = { success: true, data: { tabs: [{ tabId: 't1', label: null, url: 'https://github.com/', title: 'GitHub', active: true }] } }

let dir: string
const env = { ...process.env }
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'))
  process.env.AGENT_BROWSER_SOCKET_DIR = dir
  delete process.env.AGENT_BROWSER_SESSION
})
afterEach(() => {
  process.env = { ...env }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('keepActiveTab', () => {
  it('pins agent-browser to its tab for the operation, and unpins it after, failed or not', async () => {
    const daemon = fakeDaemon(dir, () => TABS)
    await daemon.listening
    const seen: number[] = []

    expect(await tabManager.keepActiveTab(async () => { seen.push(daemon.commands.length); return 'done' })).toBe('done')
    await expect(tabManager.keepActiveTab(async () => { throw new Error('the capture failed') })).rejects.toThrow('the capture failed')

    expect(seen).toEqual([1])
    expect(daemon.commands.map(({ action, pinTab }) => ({ action, pinTab }))).toEqual([
      { action: 'tab_list', pinTab: true },
      { action: 'tab_list', pinTab: false },
      { action: 'tab_list', pinTab: true },
      { action: 'tab_list', pinTab: false },
    ])
    await daemon.close()
  })

  it('runs the operation unpinned when the daemon will not pin, and leaves it so', async () => {
    const daemon = fakeDaemon(dir, () => ({ success: false, error: 'cannot persist the pin-tab setting' }))
    await daemon.listening

    expect(await tabManager.keepActiveTab(async () => 'done')).toBe('done')

    expect(daemon.commands).toHaveLength(1)
    await daemon.close()
  })
})
