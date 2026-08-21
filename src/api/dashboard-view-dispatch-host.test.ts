// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
} from '@shared/lib/dashboard-dispatch-schema'
import { getDashboardViewDispatchHostJs } from './dashboard-view-dispatch-host'

interface DispatchHost {
  attach(options: {
    iframe: unknown
    agentSlug: string
    artifactSlug: string
    basePath: string
  }): void
}

function installHost() {
  const run = eval
  run(getDashboardViewDispatchHostJs())
  return (window as unknown as { __gamutDispatchHost: DispatchHost }).__gamutDispatchHost
}

function sendFromSource(source: unknown, data: unknown) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

function validRequest(id: string, payload: Record<string, unknown> = {}) {
  return {
    type: DASHBOARD_DISPATCH_REQUEST_TYPE,
    id,
    payload: { prompt: '/research-user jane', ...payload },
  }
}

async function flushPromises() {
  // Response.json() settles on macrotasks (undici stream reads), so microtask
  // draining alone is not enough.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('dashboard /view dispatch host', () => {
  let contentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let iframe: { contentWindow: typeof contentWindow }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.body.innerHTML = ''
    contentWindow = { postMessage: vi.fn() }
    iframe = { contentWindow }
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/agents/agent-a/sessions' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 's-1' }), { status: 201 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function attachHost() {
    const host = installHost()
    host.attach({
      iframe,
      agentSlug: 'agent-a',
      artifactSlug: 'dash',
      basePath: '/api/agents/agent-a',
    })
    return host
  }

  function posted() {
    return contentWindow.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>)
  }

  function dialog() {
    return document.querySelector('.gamut-dispatch-dialog')
  }

  it('acks a valid request and opens the dialog naming the owning agent', async () => {
    attachHost()
    sendFromSource(contentWindow, validRequest('r1', { title: 'Research Jane' }))
    await flushPromises()

    expect(posted()).toContainEqual({ type: DASHBOARD_DISPATCH_ACK_TYPE, id: 'r1' })
    const node = dialog()
    expect(node).not.toBeNull()
    expect(node!.querySelector('h2')!.textContent).toBe('Research Jane')
    expect((node!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('/research-user jane')
    // No agent picker — the session always runs on the owning agent, named in the copy.
    expect(node!.querySelector('select')).toBeNull()
    expect(node!.textContent).toContain('agent-a')
  })

  it('ignores messages from other sources', () => {
    attachHost()
    sendFromSource({ postMessage: vi.fn() }, validRequest('r1'))

    expect(contentWindow.postMessage).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it('replies invalid_request to a malformed request with an id', () => {
    attachHost()
    sendFromSource(contentWindow, { type: DASHBOARD_DISPATCH_REQUEST_TYPE, id: 'bad', payload: {} })

    expect(posted()).toContainEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'bad',
      result: { error: 'Invalid dispatch request', code: 'invalid_request' },
    })
    expect(dialog()).toBeNull()
  })

  it('creates the session with provenance and posts the result on Dispatch', async () => {
    attachHost()
    sendFromSource(contentWindow, validRequest('r1'))
    await flushPromises()
    ;(dialog()!.querySelector('.gamut-dispatch-confirm') as HTMLButtonElement).click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/agent-a/sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(
      (fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')![1] as RequestInit)
        .body as string,
    )
    expect(body).toEqual({
      message: '/research-user jane',
      dashboardDispatch: { agentSlug: 'agent-a', dashboardSlug: 'dash' },
    })
    expect(posted()).toContainEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r1',
      result: { sessionId: 's-1', agentSlug: 'agent-a' },
    })
    expect(dialog()).toBeNull()
  })

  it('posts cancelled and removes the dialog on Cancel', async () => {
    attachHost()
    sendFromSource(contentWindow, validRequest('r1'))
    await flushPromises()
    const buttons = dialog()!.querySelectorAll('button')
    ;(buttons[0] as HTMLButtonElement).click()

    expect(posted()).toContainEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r1',
      result: { cancelled: true },
    })
    expect(dialog()).toBeNull()
  })

  it('refuses a second request as busy, then rate limits after resolution', async () => {
    attachHost()
    sendFromSource(contentWindow, validRequest('r1'))
    await flushPromises()
    sendFromSource(contentWindow, validRequest('r2'))

    expect(posted()).toContainEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r2',
      result: expect.objectContaining({ code: 'busy' }),
    })

    const buttons = dialog()!.querySelectorAll('button')
    ;(buttons[0] as HTMLButtonElement).click()
    sendFromSource(contentWindow, validRequest('r3'))

    expect(posted()).toContainEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r3',
      result: expect.objectContaining({ code: 'rate_limited' }),
    })
    expect(dialog()).toBeNull()
  })
})
