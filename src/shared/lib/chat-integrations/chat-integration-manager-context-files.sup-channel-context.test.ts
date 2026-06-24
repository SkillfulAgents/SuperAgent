import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { chatIntegrationManager, extractSlackFileId } from './chat-integration-manager'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'

const AGENT_A = 'ctx-agent-a'
const AGENT_B = 'ctx-agent-b'
let tempDataDir: string
let prevDataDir: string | undefined

function integration(agentSlug: string): any {
  return { provider: 'slack', agentSlug, config: { botToken: 'xoxb-x' } }
}
function hostUploads(agentSlug: string) {
  return path.resolve(getAgentWorkspaceDir(agentSlug), 'uploads')
}

beforeEach(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ctx-files-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
  ;(chatIntegrationManager as any).slackFileCache = new Map()
})
afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
  vi.restoreAllMocks()
})

describe('extractSlackFileId', () => {
  it('extracts the file id from a Slack files-pri URL', () => {
    expect(extractSlackFileId('https://files.slack.com/files-pri/T123-F456/secret.pdf')).toBe('F456')
  })
  it('returns null for a non-Slack host', () => {
    expect(extractSlackFileId('https://evil.example.test/files-pri/T1-F1/x')).toBeNull()
  })
  it('returns null for a Slack URL that is not a files-pri path', () => {
    expect(extractSlackFileId('https://files.slack.com/archives/C1/p123')).toBeNull()
  })
  it('returns null for a malformed URL', () => {
    expect(extractSlackFileId('not a url')).toBeNull()
  })
})

describe('downloadContextFile caching', () => {
  it('downloads a file once and reuses the cached path on re-seed', async () => {
    const buf = vi.fn(async () => Buffer.from('pdf-bytes'))
    ;(chatIntegrationManager as any).downloadFileBuffer = buf
    const file = { name: 'report.pdf', url: 'https://files.slack.com/files-pri/T1-F1/report.pdf' }
    const p1 = await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    const p2 = await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    expect(p1).toMatch(/^\/workspace\/uploads\/\d+-report\.pdf$/)
    expect(p2).toBe(p1)
    expect(buf).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(hostUploads(AGENT_A))).toHaveLength(1)
  })
  it('re-downloads when the cached file is gone (wiped workspace)', async () => {
    const buf = vi.fn(async () => Buffer.from('bytes'))
    ;(chatIntegrationManager as any).downloadFileBuffer = buf
    const file = { name: 'a.pdf', url: 'https://files.slack.com/files-pri/T1-F1/a.pdf' }
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    fs.rmSync(hostUploads(AGENT_A), { recursive: true, force: true })
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    expect(buf).toHaveBeenCalledTimes(2)
  })
  it('scopes the cache per agent (no cross-agent reuse)', async () => {
    const buf = vi.fn(async () => Buffer.from('bytes'))
    ;(chatIntegrationManager as any).downloadFileBuffer = buf
    const file = { name: 'a.pdf', url: 'https://files.slack.com/files-pri/T1-F1/a.pdf' }
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_B), file)
    expect(buf).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(hostUploads(AGENT_B))).toHaveLength(1)
  })
  it('does not cache when no Slack file id is extractable', async () => {
    const buf = vi.fn(async () => Buffer.from('bytes'))
    ;(chatIntegrationManager as any).downloadFileBuffer = buf
    const file = { name: 'a.pdf', url: 'https://example.test/not-a-slack-file' }
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)
    expect(buf).toHaveBeenCalledTimes(2)
  })
  it('returns null when the download fails', async () => {
    ;(chatIntegrationManager as any).downloadFileBuffer = vi.fn(async () => null)
    const file = { name: 'a.pdf', url: 'https://files.slack.com/files-pri/T1-F1/a.pdf' }
    expect(await (chatIntegrationManager as any).downloadContextFile(integration(AGENT_A), file)).toBeNull()
  })
})

describe('buildMessageContent context-file branching', () => {
  const message = (over: any = {}) => ({ text: 'hi', chatId: 'C1', userId: 'U1', externalMessageId: '1', timestamp: new Date(), ...over })

  it('returns plain text when there are no files of either kind', async () => {
    const out = await (chatIntegrationManager as any).buildMessageContent(integration(AGENT_A), message())
    expect(out.text).toContain('hi')
    expect(out.failedFiles).toEqual([])
  })
  it('downloads context files and appends them (no contextFiles in failedFiles on success)', async () => {
    ;(chatIntegrationManager as any).downloadFileBuffer = vi.fn(async () => Buffer.from('bytes'))
    const msg = message({ contextFiles: [{ name: 'c.pdf', url: 'https://files.slack.com/files-pri/T1-F9/c.pdf' }] })
    const out = await (chatIntegrationManager as any).buildMessageContent(integration(AGENT_A), msg)
    expect(out.text).toContain('c.pdf')
    expect(out.failedFiles).toEqual([])
  })
  it('keeps context-file failures silent (not surfaced in failedFiles)', async () => {
    ;(chatIntegrationManager as any).downloadFileBuffer = vi.fn(async () => null)
    const msg = message({ contextFiles: [{ name: 'c.pdf', url: 'https://files.slack.com/files-pri/T1-F9/c.pdf' }] })
    const out = await (chatIntegrationManager as any).buildMessageContent(integration(AGENT_A), msg)
    expect(out.failedFiles).toEqual([])
  })
  it('still surfaces current-mention file failures in failedFiles', async () => {
    ;(chatIntegrationManager as any).downloadFileBuffer = vi.fn(async () => null)
    const msg = message({ files: [{ name: 'now.pdf', url: 'https://files.slack.com/files-pri/T1-F2/now.pdf' }] })
    const out = await (chatIntegrationManager as any).buildMessageContent(integration(AGENT_A), msg)
    expect(out.failedFiles).toContain('now.pdf')
  })
})
