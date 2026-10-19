import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import type { UserInputRequestOutcome } from '@shared/lib/tools/requests/request-schema'
import type { HostCalls, HostEvents, HostPort } from './host-port'
import { runAutoApproved, runComputerUse, runScript, type HostRunActor } from './host-runs'

const SESSION = 'session-1'

/**
 * An actor over a real request store (so claims and settlement behave as
 * they do in production), with a container that takes every result unless
 * told otherwise, and a log of what the run did to it.
 */
function fakeActor(options: { containerOk?: boolean } = {}) {
  const requests = new AgentInputRequests('agent-1', { report: () => {} })
  const settled: Array<{ id: string; how: 'resolve' | 'complete' | 'clearPending'; outcome: UserInputRequestOutcome }> = []
  const containerCalls: Array<{ path: string; body: unknown }> = []
  const answered = new Set<string>()
  const frames: Record<string, unknown>[] = []
  const grants = {
    grant: vi.fn(),
    consumeOnce: vi.fn(),
    setGrabbedApp: vi.fn(),
    clearGrabbedApp: vi.fn(),
  }
  const actor: HostRunActor = {
    inputs: {
      claim: (id) => requests.claimRequest(id),
      releaseClaim: (id) => requests.releaseClaim(id),
      resolve: (id, outcome) => {
        settled.push({ id, how: 'resolve', outcome })
        return requests.resolve(id, outcome)
      },
      complete: (_sessionId, id, outcome) => {
        settled.push({ id, how: 'complete', outcome })
        requests.resolve(id, outcome)
      },
      computerUse: {
        ...grants,
        clearPending: (_sessionId, id, outcome = 'answered') => {
          settled.push({ id, how: 'clearPending', outcome })
          requests.resolve(id, outcome)
        },
      },
    },
    container: {
      // Like the container: an input takes one answer, and is gone after it.
      fetch: async (path, init) => {
        containerCalls.push({ path, body: JSON.parse(String(init?.body)) })
        const id = path.split('/')[2]
        const ok = options.containerOk !== false && !answered.has(id)
        if (ok) answered.add(id)
        return new Response('{"error":"gone"}', { status: ok ? 200 : 404 })
      },
    },
    messages: { broadcastEvent: (_sessionId, event) => frames.push(event as Record<string, unknown>) },
  }
  const park = (id: string, kind: 'computer_use' | 'script_run', autoApproved = false) =>
    requests.register({ id, kind, scope: { agentSlug: 'agent-1', sessionId: SESSION }, blocking: true, autoApproved, payload: {} })
  return { actor, requests, settled, containerCalls, frames, grants, park }
}

type CallAnswers = { [N in keyof HostCalls]?: (request: HostCalls[N]['request']) => Promise<HostCalls[N]['response']> }

/** A host whose machine calls answer as told, recording calls and sends. */
function fakeHost(answers: CallAnswers = {}) {
  const calls: Array<[keyof HostCalls, unknown]> = []
  const sent: Array<[keyof HostEvents, unknown]> = []
  const defaults: CallAnswers = {
    computerUsePermissions: async () => null,
    computerUse: async ({ method }) => `${method} ok`,
    computerUseAppIcon: async () => 'ICON',
    hostScript: async () => ({ exitCode: 0, stdout: 'hello', stderr: '' }),
  }
  const port: HostPort = {
    call: (async (name: keyof HostCalls, request: unknown) => {
      calls.push([name, request])
      const answer = (answers[name] ?? defaults[name]) as ((request: unknown) => Promise<unknown>) | undefined
      if (!answer) throw new Error(`unexpected host call ${name}`)
      return answer(request)
    }) as HostPort['call'],
    send: (name, event) => {
      sent.push([name, event])
    },
  }
  return { port, calls, sent }
}

const computerUseRun = (overrides: Partial<Parameters<typeof runComputerUse>[2]> = {}) => ({
  sessionId: SESSION,
  toolUseId: 'cu-1',
  method: 'apps',
  params: {},
  permissionLevel: 'list_apps_windows' as const,
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runComputerUse', () => {
  it('runs the command, delivers its output, settles the request and records the run', async () => {
    const { actor, park, settled, containerCalls } = fakeActor()
    const host = fakeHost()
    park('cu-1', 'computer_use')

    const outcome = await runComputerUse(actor, host.port, computerUseRun())

    expect(outcome).toEqual({ status: 'resolved' })
    expect(host.calls).toEqual([
      ['computerUsePermissions', {}],
      ['computerUse', { method: 'apps', params: {} }],
    ])
    expect(containerCalls).toEqual([{ path: '/inputs/cu-1/resolve', body: { value: 'apps ok' } }])
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'answered' }])
    expect(host.sent).toEqual([
      ['analytics', { event: 'computer_use_executed', properties: { method: 'apps', permissionLevel: 'list_apps_windows', grantType: undefined } }],
    ])
  })

  it('records the grant the user chose, and spends a once-grant on this run', async () => {
    const { actor, park, grants } = fakeActor()
    park('cu-1', 'computer_use')

    await runComputerUse(actor, fakeHost().port, computerUseRun({ permissionLevel: 'use_application', appName: 'Calculator', grantType: 'once' }))

    expect(grants.grant).toHaveBeenCalledWith('use_application', 'once', 'Calculator')
    expect(grants.consumeOnce).toHaveBeenCalledWith('use_application', 'Calculator')
  })

  it('does nothing for a request another decision holds', async () => {
    const { actor, park, requests } = fakeActor()
    const host = fakeHost()
    park('cu-1', 'computer_use')
    requests.claimRequest('cu-1')

    expect(await runComputerUse(actor, host.port, computerUseRun())).toEqual({ status: 'claimed' })
    expect(host.calls).toEqual([])
  })

  it('does nothing for a request that is not open', async () => {
    const host = fakeHost()
    expect(await runComputerUse(fakeActor().actor, host.port, computerUseRun())).toEqual({ status: 'claimed' })
    expect(host.calls).toEqual([])
  })

  it('runs nothing without the macOS permissions, and leaves the request open for a retry', async () => {
    const { actor, park, requests, containerCalls } = fakeActor()
    const permissions = { accessibility: false, screen_recording: true }
    const host = fakeHost({ computerUsePermissions: async () => permissions })
    park('cu-1', 'computer_use')

    expect(await runComputerUse(actor, host.port, computerUseRun({ grantType: 'always' }))).toEqual({
      status: 'missing_permissions',
      permissions,
    })
    expect(host.calls.map(([name]) => name)).toEqual(['computerUsePermissions'])
    expect(containerCalls).toEqual([])
    // Open and unclaimed: the next decision can take it.
    expect(requests.claimRequest('cu-1')).not.toBeNull()
  })

  it('fails the agent\'s call when the command fails, settling the request as invalidated', async () => {
    const { actor, park, settled, containerCalls } = fakeActor()
    const host = fakeHost({ computerUse: async () => { throw new Error('window not found') } })
    park('cu-1', 'computer_use')

    expect(await runComputerUse(actor, host.port, computerUseRun({ method: 'click' }))).toEqual({
      status: 'failed',
      error: 'window not found',
    })
    expect(containerCalls).toEqual([{ path: '/inputs/cu-1/reject', body: { reason: 'Error executing click: window not found' } }])
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'invalidated' }])
  })

  it('records a grab and tells the session, with the icon once the host finds it', async () => {
    const { actor, park, frames, grants } = fakeActor()
    park('cu-1', 'computer_use')

    await runComputerUse(actor, fakeHost().port, computerUseRun({ method: 'grab', permissionLevel: 'use_application', appName: 'Calculator' }))
    await vi.waitFor(() => expect(frames).toHaveLength(2))

    expect(grants.setGrabbedApp).toHaveBeenCalledWith('Calculator')
    expect(frames).toEqual([
      { type: 'computer_use_grab_changed', app: 'Calculator' },
      { type: 'computer_use_grab_changed', app: 'Calculator', appIcon: 'ICON' },
    ])
  })

  it('treats a launch as a grab of the launched app', async () => {
    const { actor, park, grants, frames } = fakeActor()
    park('cu-1', 'computer_use')

    await runComputerUse(actor, fakeHost({ computerUseAppIcon: async () => null }).port, computerUseRun({
      method: 'launch',
      params: { name: 'Notes' },
      permissionLevel: 'use_application',
    }))

    expect(grants.setGrabbedApp).toHaveBeenCalledWith('Notes')
    expect(frames).toEqual([{ type: 'computer_use_grab_changed', app: 'Notes' }])
  })

  it.each(['ungrab', 'quit'])('clears the grab on %s', async (method) => {
    const { actor, park, grants, frames } = fakeActor()
    park('cu-1', 'computer_use')

    await runComputerUse(actor, fakeHost().port, computerUseRun({ method, permissionLevel: 'use_application' }))

    expect(grants.clearGrabbedApp).toHaveBeenCalled()
    expect(frames).toEqual([{ type: 'computer_use_grab_changed', app: null }])
  })

  it('leaves the request open when the container will not take the result', async () => {
    const { actor, park, settled, requests } = fakeActor({ containerOk: false })
    park('cu-1', 'computer_use')

    expect(await runComputerUse(actor, fakeHost().port, computerUseRun())).toEqual({
      status: 'undeliverable',
      detail: '404 {"error":"gone"}',
    })
    expect(settled).toEqual([])
    expect(requests.claimRequest('cu-1')).not.toBeNull()
  })

  it('gives the claim back when the host cannot be reached', async () => {
    const { actor, park, requests } = fakeActor()
    park('cu-1', 'computer_use')
    const host = fakeHost({ computerUsePermissions: async () => { throw new Error('host down') } })

    await expect(runComputerUse(actor, host.port, computerUseRun())).rejects.toThrow('host down')
    expect(requests.claimRequest('cu-1')).not.toBeNull()
  })
})

describe('runScript', () => {
  const scriptRun = (overrides: Partial<Parameters<typeof runScript>[2]> = {}) => ({
    sessionId: SESSION,
    toolUseId: 'sr-1',
    script: 'sw_vers',
    scriptType: 'shell',
    ...overrides,
  })

  it('runs the script and delivers its exit code and output as the agent reads them', async () => {
    const { actor, park, containerCalls, settled } = fakeActor()
    const host = fakeHost({ hostScript: async () => ({ exitCode: 1, stdout: 'out', stderr: 'err' }) })
    park('sr-1', 'script_run')

    expect(await runScript(actor, host.port, scriptRun())).toEqual({ status: 'resolved' })
    expect(host.calls).toEqual([['hostScript', { script: 'sw_vers', scriptType: 'shell' }]])
    expect(containerCalls).toEqual([
      { path: '/inputs/sr-1/resolve', body: { value: 'Exit code: 1\n\nstdout:\nout\n\nstderr:\nerr' } },
    ])
    // The user decided in the app, so the other tabs hear it settled.
    expect(settled).toEqual([{ id: 'sr-1', how: 'complete', outcome: 'answered' }])
    expect(host.sent).toEqual([['analytics', { event: 'script_executed', properties: { scriptType: 'shell', exitCode: 1 } }]])
  })

  it('leaves out empty output streams', async () => {
    const { actor, park, containerCalls } = fakeActor()
    park('sr-1', 'script_run')
    await runScript(actor, fakeHost({ hostScript: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }).port, scriptRun())
    expect(containerCalls[0].body).toEqual({ value: 'Exit code: 0' })
  })

  it('settles an auto-approved request quietly: no tab ever showed it', async () => {
    const { actor, park, settled } = fakeActor()
    park('sr-1', 'script_run', true)

    await runScript(actor, fakeHost().port, scriptRun())
    expect(settled).toEqual([{ id: 'sr-1', how: 'resolve', outcome: 'answered' }])
  })

  it('records the user\'s grant and spends a once-grant on this run', async () => {
    const { actor, park, grants } = fakeActor()
    park('sr-1', 'script_run')

    await runScript(actor, fakeHost().port, scriptRun({ grantType: 'once' }))
    expect(grants.grant).toHaveBeenCalledWith('use_host_shell', 'once')
    expect(grants.consumeOnce).toHaveBeenCalledWith('use_host_shell')
  })

  it('does nothing for a request another decision holds', async () => {
    const { actor, park, requests } = fakeActor()
    const host = fakeHost()
    park('sr-1', 'script_run')
    requests.claimRequest('sr-1')

    expect(await runScript(actor, host.port, scriptRun())).toEqual({ status: 'claimed' })
    expect(host.calls).toEqual([])
  })

  it('leaves the request open when the container will not take the result', async () => {
    const { actor, park, requests, settled } = fakeActor({ containerOk: false })
    park('sr-1', 'script_run')

    expect((await runScript(actor, fakeHost().port, scriptRun())).status).toBe('undeliverable')
    expect(settled).toEqual([])
    expect(requests.claimRequest('sr-1')).not.toBeNull()
  })
})

describe('runAutoApproved', () => {
  it('runs a covered computer-use command to completion', async () => {
    const { actor, park, settled } = fakeActor()
    park('cu-1', 'computer_use', true)

    await runAutoApproved(actor, fakeHost().port, { kind: 'computerUse', ...computerUseRun() })
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'answered' }])
  })

  it('runs a second delivery of the same call not at all', async () => {
    const { actor, park } = fakeActor()
    let finish!: (output: string) => void
    const host = fakeHost({ computerUse: () => new Promise((resolve) => { finish = resolve }) })
    park('cu-1', 'computer_use', true)

    const first = runAutoApproved(actor, host.port, { kind: 'computerUse', ...computerUseRun() })
    await vi.waitFor(() => expect(host.calls.map(([name]) => name)).toContain('computerUse'))
    await runAutoApproved(actor, host.port, { kind: 'computerUse', ...computerUseRun() })
    finish('done')
    await first

    expect(host.calls.filter(([name]) => name === 'computerUse')).toHaveLength(1)
  })

  it('fails the call, naming what is missing, when computer use lacks permissions', async () => {
    const { actor, park, containerCalls, settled } = fakeActor()
    const host = fakeHost({ computerUsePermissions: async () => ({ accessibility: false, screen_recording: false }) })
    park('cu-1', 'computer_use', true)

    await runAutoApproved(actor, host.port, { kind: 'computerUse', ...computerUseRun() })

    expect(containerCalls).toEqual([{
      path: '/inputs/cu-1/reject',
      body: { reason: 'Auto-execute failed: computer use is missing macOS permissions on this machine: Accessibility, Screen Recording' },
    }])
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'invalidated' }])
  })

  it('fails the call when the run throws', async () => {
    const { actor, park, containerCalls, settled } = fakeActor()
    const host = fakeHost({ hostScript: async () => { throw new Error('spawn failed') } })
    park('sr-1', 'script_run', true)

    await runAutoApproved(actor, host.port, { kind: 'script', sessionId: SESSION, toolUseId: 'sr-1', script: 'x', scriptType: 'shell' })

    expect(containerCalls).toEqual([{ path: '/inputs/sr-1/reject', body: { reason: 'Auto-execute failed: spawn failed' } }])
    expect(settled).toEqual([{ id: 'sr-1', how: 'resolve', outcome: 'invalidated' }])
  })

  it('fails the call when the command never finishes, and ignores a late result', async () => {
    vi.useFakeTimers()
    const { actor, park, containerCalls, settled } = fakeActor()
    let finish!: (output: string) => void
    const host = fakeHost({ computerUse: () => new Promise((resolve) => { finish = resolve }) })
    park('cu-1', 'computer_use', true)

    const run = runAutoApproved(actor, host.port, { kind: 'computerUse', ...computerUseRun() })
    await vi.advanceTimersByTimeAsync(30_000)
    await run

    expect(containerCalls).toEqual([{ path: '/inputs/cu-1/reject', body: { reason: 'Auto-execute failed: no result after 30 seconds' } }])
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'invalidated' }])

    finish('too late')
    await vi.runAllTimersAsync()
    // The late result finds the call already failed: the container refuses it
    // and nothing is settled a second time.
    expect(containerCalls.at(-1)).toEqual({ path: '/inputs/cu-1/resolve', body: { value: 'too late' } })
    expect(settled).toEqual([{ id: 'cu-1', how: 'clearPending', outcome: 'invalidated' }])
  })
})
