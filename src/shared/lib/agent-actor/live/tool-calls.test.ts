import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import type { ContainerClient } from '@shared/lib/container/types'
import { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import type { HostRunActor } from '../host-runs'
import { createRecordingHostPort, type HostCallAnswers } from '../testing/recording-host-port'
import type { SessionEvent } from './session-channel'
import { ToolCalls, type Capability, type ToolCallContext, type ToolUse } from './tool-calls'

const mocks = vi.hoisted(() => ({
  capabilities: { subagents: 'allow', workflows: 'review' } as { subagents: string; workflows: string },
  runAutoApproved: vi.fn(async () => {}),
}))

vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/config/settings')>()),
  getAgentCapabilitySettings: () => mocks.capabilities,
}))

// The run itself is host-runs' business (and its own spec): here, only that
// a grant starts one, and with what.
vi.mock('../host-runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host-runs')>()),
  runAutoApproved: mocks.runAutoApproved,
}))

const SLUG = 'agent-1'
const SESSION = 'session-1'
const ORIGINAL_PLATFORM = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

type Route = (path: string, init?: RequestInit) => Response | Promise<Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/**
 * ToolCalls over a real request store and a recording host port, with the
 * rest of its context faked: a client whose fetches `route` answers (none
 * when `client: false`), computer-use grants by level (or `level:app`), and
 * logs of what it asked the session to do.
 */
function harness(options: { route?: Route; client?: false; answers?: HostCallAnswers } = {}) {
  const requests = new AgentInputRequests(SLUG, { report: () => {} })
  const granted = new Set<string>()
  let grabbedApp: string | undefined
  const computerUse = {
    check: (level: string, appName?: string) =>
      granted.has(level) || granted.has(`${level}:${appName}`) ? 'granted' : 'prompt_needed',
    grabbed: () => grabbedApp,
  } as unknown as AgentComputerUse
  const host = createRecordingHostPort(options.answers ?? {})
  const runs = { name: 'the actor' } as unknown as HostRunActor
  const events: SessionEvent[] = []
  const answered: Array<{ toolUseId: string; how: 'resolve' | 'reject'; value: string }> = []
  const fetches: string[] = []
  const capabilityGrants = new Set<Capability>()
  const launches: Array<[string, string]> = []
  let awaitingSyncs = 0
  const client = {
    fetch: async (path: string, init?: RequestInit) => {
      fetches.push(path)
      if (!options.route) throw new Error(`unexpected fetch ${path}`)
      return options.route(path, init)
    },
  } as unknown as ContainerClient
  let resolveFails = false
  const settled = new Map<string, string>()

  const ctx: ToolCallContext = {
    agentSlug: SLUG,
    sessionId: SESSION,
    requests,
    computerUse,
    host: host.port,
    runs,
    emit: (event) => events.push(event),
    transport: () => (options.client === false ? undefined : client),
    resolveInput: async (toolUseId, value) => {
      answered.push({ toolUseId, how: 'resolve', value })
      if (resolveFails) throw new Error('container gone')
    },
    rejectInput: async (toolUseId, reason) => {
      answered.push({ toolUseId, how: 'reject', value: reason })
    },
    syncAwaiting: () => {
      awaitingSyncs += 1
    },
    settled: (toolUseId, outcome) => {
      settled.set(toolUseId, outcome)
    },
    capabilityGranted: (capability) => capabilityGrants.has(capability),
    grantCapability: (capability) => {
      capabilityGrants.add(capability)
    },
    trackSubagentLaunch: (toolUseId, input) => {
      launches.push([toolUseId, input])
    },
  }
  return {
    calls: new ToolCalls(ctx),
    requests,
    host,
    runs,
    events,
    answered,
    fetches,
    capabilityGrants,
    launches,
    grant: (level: string) => granted.add(level),
    grab: (app: string) => {
      grabbedApp = app
    },
    failResolves: () => {
      resolveFails = true
    },
    awaitingSyncs: () => awaitingSyncs,
    settled,
    open: (id: string) => requests.getOpenRequest(id),
  }
}

const use = (id: string, name: string, input: unknown = {}): ToolUse => ({
  id,
  name,
  input: typeof input === 'string' ? input : JSON.stringify(input),
})

/** Let fire-and-forget work (host calls, fetches, response bodies) run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.capabilities = { subagents: 'allow', workflows: 'review' }
  mocks.runAutoApproved.mockClear()
  onPlatform('darwin')
  vi.stubEnv('E2E_MOCK', '')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  onPlatform(ORIGINAL_PLATFORM)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('ToolCalls', () => {
  describe('user-input tools on the main stream', () => {
    it('parks a question on the user and recomputes the wait', () => {
      const h = harness()
      const questions = [{ question: 'Which one?', options: [{ label: 'A' }] }]

      h.calls.mainToolUse(use('toolu_q', 'AskUserQuestion', { questions }))

      expect(h.open('toolu_q')).toMatchObject({
        kind: 'question',
        scope: { agentSlug: SLUG, sessionId: SESSION },
        blocking: true,
        autoApproved: false,
        payload: { questions },
      })
      expect(h.awaitingSyncs()).toBe(1)
      expect(h.host.sent('analytics')).toEqual([{ event: 'agent_requested_input', properties: { agentSlug: SLUG } }])
    })

    it('parks each kind with the payload its card shows', () => {
      const h = harness({ client: false })

      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'API_KEY', reason: 'deploy' }))
      h.calls.mainToolUse(use('t_account', 'mcp__user-input__request_connected_account', { toolkit: 'GitHub', reason: 'repos' }))
      h.calls.mainToolUse(use('t_file', 'mcp__user-input__request_file', { description: 'Your CV', fileTypes: ['.pdf'] }))
      h.calls.mainToolUse(use('t_mcp', 'mcp__user-input__request_remote_mcp', { url: 'https://mcp.example', name: 'Ex', clientId: 'cid' }))
      h.calls.mainToolUse(use('t_browser', 'mcp__user-input__request_browser_input', { message: 'Log in', requirements: 'a string' }))

      expect(h.open('t_secret')).toMatchObject({ kind: 'secret', payload: { secretName: 'API_KEY', reason: 'deploy' } })
      expect(h.open('t_account')).toMatchObject({ kind: 'connected_account', payload: { toolkit: 'github', reason: 'repos' } })
      expect(h.open('t_file')).toMatchObject({ kind: 'file', payload: { description: 'Your CV', fileTypes: ['.pdf'] } })
      expect(h.open('t_mcp')).toMatchObject({ kind: 'remote_mcp', payload: { url: 'https://mcp.example', name: 'Ex', clientId: 'cid' } })
      // The model controls `requirements`: a non-array becomes [].
      expect(h.open('t_browser')).toMatchObject({ kind: 'browser_input', payload: { message: 'Log in', requirements: [] } })
      expect(h.host.sent('analytics').map((e) => e.event)).toEqual([
        'agent_request_secret',
        'agent_request_connected_account',
        'agent_request_file',
        'agent_request_remote_mcp',
        'agent_request_browser_input',
      ])
    })

    it('parks a sign-in request once the host leaves it to the user, with the fields its form draws and no refs', async () => {
      const h = harness({ client: false, answers: { loginRequest: { action: 'ask', vault: { mode: 'new' } } } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', {
        message: 'Sign in to GitHub.',
        fields: [
          { ref: '@e3', kind: 'username', label: 'Email' },
          { ref: '@e4', kind: 'pin', label: 'PIN' },
          { ref: '@e5', kind: 'password', label: 'Password' },
        ],
        submit: '@e6',
      }))
      // No card while the host decides: the vault may sign in without the user.
      expect(h.open('t_login')).toBeNull()
      await settle()

      expect(h.host.calls).toEqual([['loginRequest', {
        agentSlug: SLUG,
        sessionId: SESSION,
        toolUseId: 't_login',
        input: expect.stringContaining('Sign in to GitHub.'),
      }]])
      expect(h.open('t_login')).toMatchObject({
        kind: 'login',
        payload: { message: 'Sign in to GitHub.', fields: [{ kind: 'username', label: 'Email' }, { kind: 'password', label: 'Password' }], vault: { mode: 'new' } },
      })
      expect(JSON.stringify(h.open('t_login')?.payload)).not.toContain('@e')
      // Its context comes from the container through the host, not at parking.
      expect(h.fetches).toEqual([])
      expect(h.host.sent('analytics').map((e) => e.event)).toEqual(['agent_request_login'])
    })

    it('raises no card for a sign-in request the host answered from the vault', async () => {
      const h = harness({ client: false, answers: { loginRequest: { action: 'settled' } } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [], username: 'octocat' }))
      await settle()

      expect(h.open('t_login')).toBeNull()
      expect(h.requests.getOpenRequests()).toEqual([])
      // Settled for the transcript too: a sibling can hold its result back,
      // and an unanswered-looking call must not be parked again meanwhile.
      expect(h.settled.get('t_login')).toBe('answered')
    })

    it('settles a sign-in request whose call the host found already ended, without a card', async () => {
      const h = harness({ client: false, answers: { loginRequest: { action: 'none' } } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [] }))
      await settle()

      expect(h.open('t_login')).toBeNull()
      expect(h.settled.get('t_login')).toBe('cancelled')
    })

    it('raises no card for a sign-in request whose call ended while the host decided', async () => {
      let decide: (decision: { action: 'ask'; vault: Record<string, unknown> }) => void = () => {}
      const h = harness({ client: false, answers: { loginRequest: () => new Promise((resolve) => { decide = resolve }) } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [] }))
      await settle()
      h.calls.mainToolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 't_login', content: 'cancelled', is_error: true }] } })
      decide({ action: 'ask', vault: { mode: 'new' } })
      await settle()

      expect(h.open('t_login')).toBeNull()
    })

    it('raises no recovered card for a sign-in request the host is still deciding', async () => {
      let decide: (decision: { action: 'settled' }) => void = () => {}
      const h = harness({ client: false, answers: { loginRequest: () => new Promise((resolve) => { decide = resolve }) } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [] }))
      // A reattach reads the transcript: the call has no result yet.
      h.calls.recoverParked([{ toolUseId: 't_login', toolName: 'mcp__user-input__request_login' }])
      expect(h.open('t_login')).toBeNull()

      decide({ action: 'settled' })
      await settle()
      expect(h.open('t_login')).toBeNull()
    })

    it('asks the host once for a sign-in request the stream and the message both carry', async () => {
      const h = harness({ client: false, answers: { loginRequest: { action: 'ask', vault: { mode: 'new' } } } })
      const call = use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [] })

      h.calls.mainToolUse(call)
      h.calls.mainToolUse(call)
      await settle()

      expect(h.host.calls).toHaveLength(1)
      expect(h.open('t_login')).not.toBeNull()
    })

    it('leaves a sign-in request to the user when the host cannot decide it', async () => {
      const h = harness({ client: false, answers: { loginRequest: async () => { throw new Error('host gone') } } })

      h.calls.mainToolUse(use('t_login', 'mcp__user-input__request_login', { message: 'Sign in to GitHub.', fields: [] }))
      await settle()

      expect(h.open('t_login')).toMatchObject({ kind: 'login', payload: { vault: { mode: 'new' } } })
    })

    it('parks no sign-in request without a reason, and none with fields that are not a list', async () => {
      const h = harness({ client: false, answers: { loginRequest: { action: 'ask', vault: { mode: 'new' } } } })
      h.calls.mainToolUse(use('t_blank', 'mcp__user-input__request_login', { message: '   ', fields: [] }))
      h.calls.mainToolUse(use('t_bad', 'mcp__user-input__request_login', { message: 'Sign in.', fields: 'username' }))
      await settle()
      expect(h.open('t_blank')).toBeNull()
      expect(h.open('t_bad')).toBeNull()
      expect(h.host.calls).toEqual([])
    })

    it('parks nothing for an ask missing its required field, but still recomputes the wait', () => {
      const h = harness()

      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { reason: 'no name' }))
      h.calls.mainToolUse(use('t_q', 'AskUserQuestion', { questions: [] }))

      expect(h.requests.getOpenRequests()).toEqual([])
      expect(h.awaitingSyncs()).toBe(2)
    })

    it('parks nothing for an ask whose input is not JSON, but still recomputes the wait', () => {
      const h = harness()

      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', '{"secretName":'))

      expect(h.open('t_secret')).toBeNull()
      expect(h.awaitingSyncs()).toBe(1)
    })

    it('keeps the first delivery of an ask', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'FIRST' }))

      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'SECOND' }))

      expect(h.open('t_secret')?.payload).toMatchObject({ secretName: 'FIRST' })
    })

    it('records the page a browser hand-off was asked on, from the machine', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const h = harness({ route: () => json({ url: 'https://bank.example/login' }) })

      h.calls.mainToolUse(use('t_browser', 'mcp__user-input__request_browser_input', { message: 'Log in' }))
      await settle()

      expect(h.fetches).toEqual([`/browser/credential-context?sessionId=${SESSION}`])
      expect(h.open('t_browser')?.payload).toMatchObject({
        browserContext: { url: 'https://bank.example/login', capturedAt: 1_000 },
      })
    })

    it('leaves the hand-off as it is when the page cannot be read', async () => {
      const h = harness({ route: () => json({ error: 'no browser' }, 500) })

      h.calls.mainToolUse(use('t_browser', 'mcp__user-input__request_browser_input', { message: 'Log in' }))
      await settle()

      expect(h.fetches).toHaveLength(1)
      expect(h.open('t_browser')?.payload).not.toHaveProperty('browserContext')
    })
  })

  describe('recovered asks', () => {
    it('re-registers an unanswered ask the transcript shows, as a stub marked recovered', () => {
      const h = harness()

      h.calls.recoverParked([
        { toolUseId: 't_q', toolName: 'AskUserQuestion' },
        { toolUseId: 't_bash', toolName: 'Bash' },
        { toolUseId: 't_script', toolName: 'mcp__user-input__request_script_run' },
      ])

      expect(h.open('t_q')).toMatchObject({ kind: 'question', payload: { recovered: true } })
      expect(h.open('t_bash')).toBeNull()
      expect(h.open('t_script')).toBeNull()
    })

    it('leaves an ask that is already open alone', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'KEY' }))

      h.calls.recoverParked([{ toolUseId: 't_secret', toolName: 'mcp__user-input__request_secret' }])

      expect(h.open('t_secret')?.payload).toEqual({ secretName: 'KEY' })
    })

    it('lets the real delivery replace a recovered stub with a renderable ask', () => {
      const h = harness()
      h.calls.recoverParked([{ toolUseId: 't_secret', toolName: 'mcp__user-input__request_secret' }])

      h.calls.mainToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'KEY' }))

      expect(h.open('t_secret')?.payload).toEqual({ secretName: 'KEY' })
    })
  })

  describe('host tools', () => {
    it('has the host run the tool and delivers its result, after the events it asked for', async () => {
      const h = harness({
        answers: {
          hostTool: { status: 'resolved', value: 'Scheduled task 42', sessionEvents: [{ type: 'scheduled_task_created', taskId: 42 }] },
        },
      })

      h.calls.mainToolUse(use('t_sched', 'mcp__user-input__schedule_task', { prompt: 'x', when: 'tomorrow' }))
      await settle()

      expect(h.host.calls).toEqual([
        ['hostTool', {
          agentSlug: SLUG,
          sessionId: SESSION,
          toolUseId: 't_sched',
          toolName: 'schedule_task',
          input: JSON.stringify({ prompt: 'x', when: 'tomorrow' }),
        }],
      ])
      expect(h.events).toEqual([{ type: 'scheduled_task_created', taskId: 42 }])
      expect(h.answered).toEqual([{ toolUseId: 't_sched', how: 'resolve', value: 'Scheduled task 42' }])
    })

    it('fails the call with the host\'s reason when the host rejects it', async () => {
      const h = harness({ answers: { hostTool: { status: 'rejected', reason: 'Invalid cron' } } })

      h.calls.mainToolUse(use('t_sched', 'mcp__user-input__schedule_task', {}))
      await settle()

      expect(h.answered).toEqual([{ toolUseId: 't_sched', how: 'reject', value: 'Invalid cron' }])
    })

    it('fails the call when the host could not run it', async () => {
      const h = harness({
        answers: {
          hostTool: () => {
            throw new Error('database locked')
          },
        },
      })

      h.calls.mainToolUse(use('t_trig', 'mcp__user-input__list_triggers', {}))
      await settle()

      expect(h.answered).toEqual([{ toolUseId: 't_trig', how: 'reject', value: 'Failed to run list_triggers: database locked' }])
    })

    it('never fails a call the host decided, when only its delivery failed', async () => {
      const h = harness({ answers: { hostTool: { status: 'resolved', value: 'Saved' } } })
      h.failResolves()

      h.calls.mainToolUse(use('t_sched', 'mcp__user-input__schedule_task', {}))
      await settle()

      expect(h.answered).toEqual([{ toolUseId: 't_sched', how: 'resolve', value: 'Saved' }])
    })

    it('leaves a tool that is not the host\'s alone', async () => {
      const h = harness()

      h.calls.mainToolUse(use('t_bash', 'Bash', { command: 'ls' }))
      h.calls.mainToolUse(use('t_unknown', 'mcp__user-input__not_a_host_tool', {}))
      await settle()

      expect(h.host.calls).toEqual([])
      expect(h.answered).toEqual([])
    })

    it('runs host tools from the main stream only', async () => {
      const h = harness({ answers: { hostTool: { status: 'resolved', value: 'ok' } } })

      h.calls.subagentStreamedToolUse(use('t_sched', 'mcp__user-input__schedule_task', {}), 'toolu_parent')
      h.calls.subagentMessageToolUse(use('t_sched2', 'mcp__user-input__schedule_task', {}), 'toolu_parent')
      await settle()

      expect(h.host.calls).toEqual([])
    })
  })

  describe('host scripts', () => {
    const script = { script: 'echo hi', scriptType: 'shell', explanation: 'Say hi' }

    it('parks a script on an approval card without a grant', () => {
      const h = harness()

      h.calls.mainToolUse(use('t_script', 'mcp__user-input__request_script_run', script))

      expect(h.open('t_script')).toMatchObject({
        kind: 'script_run',
        autoApproved: false,
        payload: { script: 'echo hi', explanation: 'Say hi', scriptType: 'shell' },
      })
      expect(h.awaitingSyncs()).toBe(1)
      expect(mocks.runAutoApproved).not.toHaveBeenCalled()
    })

    it('runs a script at once under a use_host_shell grant, registered but not waited on', () => {
      const h = harness()
      h.grant('use_host_shell')

      h.calls.mainToolUse(use('t_script', 'mcp__user-input__request_script_run', script))

      expect(h.open('t_script')).toMatchObject({ kind: 'script_run', autoApproved: true })
      expect(h.awaitingSyncs()).toBe(0)
      expect(mocks.runAutoApproved).toHaveBeenCalledWith(h.runs, h.host.port, {
        kind: 'script',
        sessionId: SESSION,
        toolUseId: 't_script',
        script: 'echo hi',
        scriptType: 'shell',
      })
    })

    it('rejects a script type this platform cannot run', () => {
      onPlatform('linux')
      const h = harness()

      h.calls.mainToolUse(use('t_script', 'mcp__user-input__request_script_run', { script: 'x', scriptType: 'applescript' }))

      expect(h.answered).toEqual([{
        toolUseId: 't_script',
        how: 'reject',
        value: 'Script type "applescript" is not supported on linux. Supported types: shell',
      }])
      expect(h.open('t_script')).toBeNull()
    })

    it('rejects every script on a platform with no script support', () => {
      onPlatform('freebsd')
      const h = harness()

      h.calls.mainToolUse(use('t_script', 'mcp__user-input__request_script_run', script))

      expect(h.answered).toEqual([{
        toolUseId: 't_script',
        how: 'reject',
        value: 'Host script execution is not supported on this platform (freebsd). Only macOS and Windows are supported.',
      }])
    })

    it('ignores a script request missing its script or type, or not JSON', () => {
      const h = harness()

      h.calls.mainToolUse(use('t_1', 'mcp__user-input__request_script_run', { scriptType: 'shell' }))
      h.calls.mainToolUse(use('t_2', 'mcp__user-input__request_script_run', { script: 'x' }))
      h.calls.mainToolUse(use('t_3', 'mcp__user-input__request_script_run', '{"script'))

      expect(h.requests.getOpenRequests()).toEqual([])
      expect(h.answered).toEqual([])
    })

    it('parks a subagent\'s script under the subagent that asked', () => {
      const h = harness()

      h.calls.subagentStreamedToolUse(use('t_script', 'mcp__user-input__request_script_run', script), 'toolu_parent')

      expect(h.open('t_script')).toMatchObject({ kind: 'script_run', parentToolUseId: 'toolu_parent' })
    })
  })

  describe('computer use', () => {
    it('parks a command no grant covers on an approval card', async () => {
      const h = harness()

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_click', { app: 'Safari', ref: '@e1' }))
      await settle()

      expect(h.open('t_cu')).toMatchObject({
        kind: 'computer_use',
        autoApproved: false,
        payload: { method: 'click', params: { app: 'Safari', ref: '@e1' }, permissionLevel: 'use_application', appName: 'Safari' },
      })
      expect(h.awaitingSyncs()).toBe(1)
      expect(mocks.runAutoApproved).not.toHaveBeenCalled()
    })

    it('runs a command a grant covers at once, registered but not waited on', async () => {
      const h = harness()
      h.grant('use_application:Safari')

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_click', { app: 'Safari', ref: '@e1' }))
      await settle()

      expect(h.open('t_cu')).toMatchObject({ kind: 'computer_use', autoApproved: true })
      expect(h.awaitingSyncs()).toBe(0)
      expect(mocks.runAutoApproved).toHaveBeenCalledWith(h.runs, h.host.port, {
        kind: 'computerUse',
        sessionId: SESSION,
        toolUseId: 't_cu',
        method: 'click',
        params: { app: 'Safari', ref: '@e1' },
        permissionLevel: 'use_application',
        appName: 'Safari',
      })
    })

    it('targets the grabbed app when the command names none', async () => {
      const h = harness()
      h.grab('Notes')

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_type', { text: 'hello' }))
      await settle()

      expect(h.open('t_cu')?.payload).toMatchObject({ method: 'type', appName: 'Notes' })
    })

    it('takes a command with no input as one with no params', async () => {
      const h = harness()

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_apps', ''))
      await settle()

      expect(h.open('t_cu')?.payload).toMatchObject({ method: 'apps', params: {}, permissionLevel: 'list_apps_windows' })
    })

    it('judges a computer_run by the command it wraps', async () => {
      const h = harness()
      h.grant('list_apps_windows')

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_run', { command: 'apps', args: {} }))
      await settle()

      expect(mocks.runAutoApproved).toHaveBeenCalledWith(h.runs, h.host.port, expect.objectContaining({
        method: 'apps',
        params: {},
        permissionLevel: 'list_apps_windows',
      }))
    })

    it('asks the machine which app owns a window before judging a grab by ref', async () => {
      const h = harness({ answers: { computerUseWindowApp: 'Finder' } })

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_grab', { ref: 'w-17' }))
      await settle()

      expect(h.host.calls).toEqual([['computerUseWindowApp', { ref: 'w-17' }]])
      expect(h.open('t_cu')?.payload).toMatchObject({ method: 'grab', appName: 'Finder' })
    })

    it('judges a grab without its app when the machine cannot say', async () => {
      const h = harness({
        answers: {
          computerUseWindowApp: () => {
            throw new Error('no such window')
          },
        },
      })

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_grab', { ref: 'w-17' }))
      await settle()

      expect(h.open('t_cu')).toMatchObject({ kind: 'computer_use', payload: { method: 'grab' } })
      expect(h.open('t_cu')?.payload).not.toHaveProperty('appName', expect.any(String))
    })

    it('rejects a command on a platform computer use does not support', async () => {
      onPlatform('linux')
      const h = harness()

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_apps', {}))
      await settle()

      expect(h.answered).toEqual([{
        toolUseId: 't_cu',
        how: 'reject',
        value: 'Computer use is not supported on this platform (linux). macOS and Windows are supported.',
      }])
      expect(h.open('t_cu')).toBeNull()
    })

    it('parks commands on any platform under the mock E2E runtime', async () => {
      onPlatform('linux')
      vi.stubEnv('E2E_MOCK', 'true')
      const h = harness()

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_apps', {}))
      await settle()

      expect(h.open('t_cu')).toMatchObject({ kind: 'computer_use' })
    })

    it('ignores a command whose input is not JSON', async () => {
      const h = harness()

      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_click', '{"app":'))
      await settle()

      expect(h.open('t_cu')).toBeNull()
      expect(h.answered).toEqual([])
    })

    it('parks a subagent\'s command under the subagent, from either path', async () => {
      const h = harness()

      h.calls.subagentStreamedToolUse(use('t_cu1', 'mcp__computer-use__computer_apps', {}), 'toolu_parent')
      h.calls.subagentMessageToolUse(use('t_cu2', 'mcp__computer-use__computer_apps', {}), 'toolu_parent')
      await settle()

      expect(h.open('t_cu1')).toMatchObject({ parentToolUseId: 'toolu_parent' })
      expect(h.open('t_cu2')).toMatchObject({ parentToolUseId: 'toolu_parent' })
    })
  })

  describe('capability review', () => {
    beforeEach(() => {
      mocks.capabilities = { subagents: 'review', workflows: 'review' }
    })

    it('parks a launch under a review policy on an approval card', async () => {
      const h = harness({ client: false })

      h.calls.mainToolUse(use('toolu_task', 'Task', { description: 'Research', prompt: 'go' }))
      h.calls.mainToolUse(use('toolu_wf', 'Workflow', { name: 'deploy' }))
      await settle()

      expect(h.open('toolu_task')).toMatchObject({
        kind: 'capability_review',
        payload: { capability: 'subagents', toolName: 'Task', input: { description: 'Research', prompt: 'go' } },
      })
      expect(h.open('toolu_wf')).toMatchObject({
        kind: 'capability_review',
        payload: { capability: 'workflows', toolName: 'Workflow', input: { name: 'deploy' } },
      })
      expect(h.awaitingSyncs()).toBe(2)
    })

    it('shows no card under an allow policy', async () => {
      mocks.capabilities = { subagents: 'allow', workflows: 'block' }
      const h = harness({ client: false })

      h.calls.mainToolUse(use('toolu_agent', 'Agent', {}))
      h.calls.mainToolUse(use('toolu_wf', 'Workflow', {}))
      await settle()

      expect(h.requests.getOpenRequests()).toEqual([])
    })

    it('shows no card when the session holds a grant', async () => {
      const h = harness({ client: false })
      h.capabilityGrants.add('subagents')

      h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      await settle()

      expect(h.open('toolu_task')).toBeNull()
    })

    it('takes the container\'s persisted grant over a cold mirror, and remembers it', async () => {
      const h = harness({ route: () => json({ grants: ['subagents'] }) })

      h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      await settle()

      expect(h.fetches).toEqual([`/sessions/${SESSION}/capability-grants`])
      expect(h.open('toolu_task')).toBeNull()
      expect(h.capabilityGrants.has('subagents')).toBe(true)
    })

    it('shows the card when the container holds no grant for this capability', async () => {
      const h = harness({ route: () => json({ grants: ['workflows'] }) })

      h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      await settle()

      expect(h.open('toolu_task')).toMatchObject({ kind: 'capability_review' })
    })

    it('shows the card when the grant lookup fails', async () => {
      const failing = harness({ route: () => Promise.reject(new Error('socket hang up')) })
      const notOk = harness({ route: () => json({ error: 'nope' }, 500) })
      const malformed = harness({ route: () => json({ grants: 'all' }) })

      for (const h of [failing, notOk, malformed]) {
        h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      }
      await settle()

      for (const h of [failing, notOk, malformed]) expect(h.open('toolu_task')).toMatchObject({ kind: 'capability_review' })
    })

    it('shows what there is of an unparseable launch', async () => {
      const h = harness({ client: false })

      h.calls.mainToolUse(use('toolu_task', 'Task', '{"descr'))
      await settle()

      expect(h.open('toolu_task')?.payload).toMatchObject({ capability: 'subagents', input: {} })
    })

    it('drops the card of a review the container stopped waiting on while the lookup ran', async () => {
      const answers: Array<(response: Response) => void> = []
      const h = harness({ route: () => new Promise<Response>((resolve) => answers.push(resolve)) })
      h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      h.calls.mainToolUse(use('toolu_kept', 'Agent', {}))
      await settle()

      expect(h.calls.reviewCancelled('toolu_task')).toBe('tombstoned')
      for (const answer of answers) answer(json({ grants: [] }))
      await settle()

      expect(h.open('toolu_task')).toBeNull()
      expect(h.open('toolu_kept')).toMatchObject({ kind: 'capability_review' })
      expect(h.awaitingSyncs()).toBe(1)
    })

    it('reports a cancelled review whose card is open as one to close', async () => {
      const h = harness({ client: false })
      h.calls.mainToolUse(use('toolu_task', 'Task', {}))
      await settle()

      expect(h.calls.reviewCancelled('toolu_task')).toBe('closed')
    })

    it('reviews a subagent\'s nested launch from its stream, not from its complete message', async () => {
      const h = harness({ client: false })

      h.calls.subagentStreamedToolUse(use('toolu_nested', 'Task', {}), 'toolu_parent')
      h.calls.subagentMessageToolUse(use('toolu_nested2', 'Task', {}), 'toolu_parent')
      await settle()

      expect(h.open('toolu_nested')).toMatchObject({ kind: 'capability_review' })
      expect(h.open('toolu_nested2')).toBeNull()
    })
  })

  describe('subagent launches', () => {
    it('starts a subagent entry for a Task or Agent call, from every path', () => {
      const h = harness()

      h.calls.mainToolUse(use('toolu_1', 'Task', { prompt: 'a' }))
      h.calls.mainToolUse(use('toolu_2', 'Agent', { prompt: 'b' }))
      h.calls.subagentStreamedToolUse(use('toolu_3', 'Task', { prompt: 'c' }), 'toolu_1')
      h.calls.subagentMessageToolUse(use('toolu_4', 'Agent', { prompt: 'd' }), 'toolu_2')
      h.calls.mainToolUse(use('toolu_5', 'Workflow', {}))

      expect(h.launches).toEqual([
        ['toolu_1', '{"prompt":"a"}'],
        ['toolu_2', '{"prompt":"b"}'],
        ['toolu_3', '{"prompt":"c"}'],
        ['toolu_4', '{"prompt":"d"}'],
      ])
    })
  })

  describe('subagent asks', () => {
    it('parks a subagent\'s ask under the subagent, and keeps its first delivery', () => {
      const h = harness()

      h.calls.subagentStreamedToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'A' }), 'toolu_parent')
      h.calls.subagentMessageToolUse(use('t_secret', 'mcp__user-input__request_secret', { secretName: 'B' }), 'toolu_parent')

      expect(h.open('t_secret')).toMatchObject({ parentToolUseId: 'toolu_parent', payload: { secretName: 'A' } })
    })

    it('sends no analytics for a subagent\'s asks', () => {
      const h = harness()

      h.calls.subagentStreamedToolUse(use('t_q', 'AskUserQuestion', { questions: [{ question: 'x' }] }), 'toolu_parent')

      expect(h.host.sent('analytics')).toEqual([])
    })
  })

  describe('deliver_file', () => {
    it('tells chat clients the file can go once its result confirms it', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_file', 'mcp__user-input__deliver_file', { filePath: '/workspace/report.pdf', description: 'The report' }))
      expect(h.events).toEqual([])

      h.calls.mainToolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 't_file', content: 'Delivered' }] } })

      expect(h.events).toEqual([
        { type: 'tool_result', toolUseId: 't_file', result: 'Delivered', isError: false },
        {
          type: 'tool_result_ready',
          toolName: 'mcp__user-input__deliver_file',
          toolUseId: 't_file',
          filePath: '/workspace/report.pdf',
          description: 'The report',
          isError: false,
        },
      ])
    })

    it('says the delivery failed when its result is an error, and says it once', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_file', 'mcp__user-input__deliver_file', { filePath: '/workspace/missing.pdf' }))
      const result = { message: { content: [{ type: 'tool_result', tool_use_id: 't_file', content: 'No such file', is_error: true }] } }

      h.calls.mainToolResults(result)
      h.calls.mainToolResults(result)

      expect(h.events.filter((e) => e.type === 'tool_result_ready')).toEqual([
        expect.objectContaining({ filePath: '/workspace/missing.pdf', description: undefined, isError: true }),
      ])
    })

    it('remembers nothing for a delivery without a file path', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_1', 'mcp__user-input__deliver_file', { description: 'no path' }))
      h.calls.mainToolUse(use('t_2', 'mcp__user-input__deliver_file', '{"filePa'))

      h.calls.mainToolResults({ message: { content: [
        { type: 'tool_result', tool_use_id: 't_1', content: 'x' },
        { type: 'tool_result', tool_use_id: 't_2', content: 'x' },
      ] } })

      expect(h.events.map((e) => e.type)).toEqual(['tool_result', 'tool_result'])
    })
  })

  describe('main-stream tool results', () => {
    it('settles the ask each result answers, declined for an error, and tells clients', () => {
      const h = harness()
      h.calls.mainToolUse(use('t_a', 'mcp__user-input__request_secret', { secretName: 'A' }))
      h.calls.mainToolUse(use('t_b', 'mcp__user-input__request_secret', { secretName: 'B' }))
      const before = h.awaitingSyncs()

      h.calls.mainToolResults({ message: { content: [
        { type: 'tool_result', tool_use_id: 't_a', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't_b', content: 'User declined', is_error: true },
        { type: 'text', text: 'not a result' },
      ] } })

      expect(h.open('t_a')).toBeNull()
      expect(h.open('t_b')).toBeNull()
      expect(h.requests.getRecentResolution('t_a')?.outcome).toBe('answered')
      expect(h.requests.getRecentResolution('t_b')?.outcome).toBe('declined')
      expect(h.events).toEqual([
        { type: 'tool_result', toolUseId: 't_a', result: 'ok', isError: false },
        { type: 'tool_result', toolUseId: 't_b', result: 'User declined', isError: true },
      ])
      expect(h.awaitingSyncs()).toBe(before + 1)
    })

    it('leaves a computer-use request to its own store', async () => {
      const h = harness()
      h.calls.mainToolUse(use('t_cu', 'mcp__computer-use__computer_apps', {}))
      await settle()

      h.calls.mainToolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 't_cu', content: 'apps' }] } })

      expect(h.open('t_cu')).toMatchObject({ kind: 'computer_use' })
    })

    it('still recomputes the wait for a message with no results', () => {
      const h = harness()

      h.calls.mainToolResults({ message: { content: 'plain text' } })

      expect(h.events).toEqual([])
      expect(h.awaitingSyncs()).toBe(1)
    })
  })

  describe('subagent tool results', () => {
    it('settles and announces only the results that answer a parked ask', () => {
      const h = harness({ client: false })
      h.calls.subagentStreamedToolUse(use('t_browser', 'mcp__user-input__request_browser_input', { message: 'Log in' }), 'toolu_parent')

      h.calls.subagentToolResults({ message: { content: [
        { type: 'tool_result', tool_use_id: 'inner_bash', content: 'file list' },
        { type: 'tool_result', tool_use_id: 't_browser', content: 'Done' },
      ] } })

      expect(h.open('t_browser')).toBeNull()
      expect(h.events).toEqual([{ type: 'tool_result', toolUseId: 't_browser', result: 'Done', isError: false }])
    })

    it('ignores a message with no blocks', () => {
      const h = harness()
      const before = h.awaitingSyncs()

      h.calls.subagentToolResults({ message: { content: 'text' } })

      expect(h.events).toEqual([])
      expect(h.awaitingSyncs()).toBe(before)
    })
  })
})
