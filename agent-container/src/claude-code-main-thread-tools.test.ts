/**
 * The main conversation's own tools (main-thread-tools.ts) are denied inside
 * a subagent. A PreToolUse hook, not canUseTool: under bypassPermissions the
 * SDK approves a regular tool call before canUseTool is consulted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('./input-manager', () => ({
  inputManager: { setCurrentToolUseId: vi.fn() },
  HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000,
}))

import { ClaudeCodeProcess } from './claude-code'
import { MAIN_THREAD_ONLY_TOOL_MESSAGE } from './main-thread-tools'

type HookOutput = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, opts: { signal: AbortSignal }) => Promise<HookOutput>
type Matchers = Array<{ matcher?: string; hooks: HookFn[] }>

/** What every PreToolUse hook whose matcher selects the tool decides about this call. */
async function preToolUse(toolName: string, agentId?: string): Promise<HookOutput[]> {
  const process = new ClaudeCodeProcess({ sessionId: `main-thread-${calls.length}`, workingDirectory: '/tmp' })
  await process.start()
  const matchers = (calls[calls.length - 1].options.hooks as Record<string, Matchers>).PreToolUse
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: { wakeTime: 'tomorrow 9am', note: 'Check back' },
    tool_use_id: 'tool-1',
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  }
  const outputs: HookOutput[] = []
  for (const { matcher, hooks } of matchers) {
    if (matcher === undefined || !new RegExp(matcher).test(toolName)) continue
    for (const hook of hooks) outputs.push(await hook(input, 'tool-1', { signal: new AbortController().signal }))
  }
  await process.stop()
  return outputs
}

const denials = (outputs: HookOutput[]) =>
  outputs.map((o) => o.hookSpecificOutput).filter((o) => o?.permissionDecision === 'deny')

describe('ClaudeCodeProcess main-thread-only tools', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('denies schedule_resume inside a subagent, saying why', async () => {
    const outputs = await preToolUse('mcp__user-input__schedule_resume', 'agent-abc')

    expect(denials(outputs)).toEqual([
      expect.objectContaining({ permissionDecision: 'deny', permissionDecisionReason: MAIN_THREAD_ONLY_TOOL_MESSAGE }),
    ])
  })

  it('lets the main conversation call schedule_resume', async () => {
    expect(denials(await preToolUse('mcp__user-input__schedule_resume'))).toEqual([])
  })

  it('lets a subagent call the other host tools', async () => {
    expect(denials(await preToolUse('mcp__user-input__schedule_task', 'agent-abc'))).toEqual([])
    expect(denials(await preToolUse('mcp__user-input__list_triggers', 'agent-abc'))).toEqual([])
  })
})
