/**
 * The Write/Edit wiring for FileHook.onChange: the file is read before the
 * tool call and handed to the hook with its content after, and a failed call
 * drops what was read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: Record<string, unknown> }) => {
    calls.push({ options: args.options })
    const abortController = args.options.abortController as AbortController
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () =>
        new Promise<IteratorResult<never>>((resolve) => {
          if (abortController.signal.aborted) resolve({ value: undefined, done: true })
          abortController.signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true })
        }),
      return: () => Promise.resolve({ value: undefined, done: true }),
      interrupt: () => Promise.resolve(),
    }
  }),
}))

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
  createMeetingsMcpServer: () => ({}),
  createRulesMcpServer: () => ({}),
}))

vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ computerUseTools: [] }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

const changeHook = vi.hoisted(() => ({
  watched: new Set<string>(),
  matches(filePath: string) {
    return this.watched.has(filePath)
  },
  onRead: () => ({}),
  onWrite: () => ({}),
  onEdit: () => ({}),
  onChange: vi.fn((_filePath: string, _before: string | null, _after: string) => ({ warning: 'changed' })),
}))

vi.mock('./file-hooks', () => ({
  fileHooks: [changeHook],
  resolveToolFilePath: (toolInput: Record<string, unknown>) => (toolInput.file_path as string | undefined) ?? null,
  mountIndexCommandHint: () => undefined,
}))

import { ClaudeCodeProcess } from './claude-code'

type HookFn = (input: unknown, toolUseId: string | undefined) => Promise<Record<string, unknown>>
type Matchers = Array<{ matcher?: string; hooks: HookFn[] }>

async function startHooks() {
  const process = new ClaudeCodeProcess({ sessionId: `file-change-${calls.length}`, workingDirectory: '/tmp' })
  await process.start()
  const hooks = calls[calls.length - 1].options.hooks as Record<string, Matchers>
  const find = (event: string) => hooks[event].find((m) => m.matcher === 'Write|Edit')!.hooks[0]
  return { process, before: find('PreToolUse'), after: find('PostToolUse'), failed: find('PostToolUseFailure') }
}

describe('ClaudeCodeProcess file change hooks', () => {
  let dir: string

  beforeEach(() => {
    calls.length = 0
    changeHook.onChange.mockClear()
    changeHook.watched.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-change-hooks-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('hands the hook the file before and after the call, and returns its warning', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    fs.writeFileSync(file, 'before')
    const { process, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    fs.writeFileSync(file, 'after')
    const result = await after({ tool_input: { file_path: file } }, 'tool-1')

    expect(changeHook.onChange).toHaveBeenCalledWith(file, 'before', 'after')
    expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'changed' } })
    await process.stop()
  })

  it('passes null for a file the call created', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    const { process, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    fs.writeFileSync(file, 'created')
    await after({ tool_input: { file_path: file } }, 'tool-1')

    expect(changeHook.onChange).toHaveBeenCalledWith(file, null, 'created')
    await process.stop()
  })

  it('drops the snapshot of a call that failed', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    fs.writeFileSync(file, 'before')
    const { process, before, after, failed } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    await failed({ tool_input: { file_path: file } }, 'tool-1')
    await expect(after({ tool_input: { file_path: file } }, 'tool-1')).resolves.toEqual({})

    expect(changeHook.onChange).not.toHaveBeenCalled()
    await process.stop()
  })

  it('leaves files no change hook matches alone', async () => {
    const file = path.join(dir, 'notes.md')
    fs.writeFileSync(file, 'before')
    const { process, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    fs.writeFileSync(file, 'after')
    await expect(after({ tool_input: { file_path: file } }, 'tool-1')).resolves.toEqual({})

    expect(changeHook.onChange).not.toHaveBeenCalled()
    await process.stop()
  })
})
