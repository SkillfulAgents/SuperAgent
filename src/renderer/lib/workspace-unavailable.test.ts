// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceUnavailableBodySchema } from './workspace-unavailable-schema'
import {
  WORKSPACE_UNAVAILABLE_HEADER,
  _resetWorkspaceUnavailableForTest,
  _setWorkspaceUnavailableReloadForTest,
  isWorkspaceAsleep,
  isWorkspaceUnavailableError,
  isWorkspaceUnavailableReloadPending,
  maybeReloadForWorkspaceUnavailable,
  subscribeWorkspaceAsleep,
} from './workspace-unavailable'

function jsonResponse(status: number, body: unknown, state?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(state ? { [WORKSPACE_UNAVAILABLE_HEADER]: state } : {}),
    },
  })
}

describe('workspaceUnavailableBodySchema', () => {
  it('accepts the ingress 503 body', () => {
    expect(workspaceUnavailableBodySchema.safeParse({ error: 'deployment_unavailable' }).success).toBe(true)
  })

  it('accepts the ingress 502 body', () => {
    expect(
      workspaceUnavailableBodySchema.safeParse({
        error: 'The request could not reach your workspace. Please retry.',
      }).success,
    ).toBe(true)
  })

  it('rejects an unrelated error string', () => {
    expect(workspaceUnavailableBodySchema.safeParse({ error: 'Auth config unavailable' }).success).toBe(false)
  })
})

describe('maybeReloadForWorkspaceUnavailable', () => {
  const reload = vi.fn()

  beforeEach(() => {
    _resetWorkspaceUnavailableForTest()
    _setWorkspaceUnavailableReloadForTest(reload)
    reload.mockClear()
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  afterEach(() => {
    _resetWorkspaceUnavailableForTest()
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('reloads the document on deployment_unavailable so the next load hits the waiting page', async () => {
    const response = jsonResponse(503, { error: 'deployment_unavailable', state: 'waking' })
    await maybeReloadForWorkspaceUnavailable(response)
    expect(reload).toHaveBeenCalledOnce()
    expect(isWorkspaceUnavailableReloadPending()).toBe(true)
    expect(await response.json()).toEqual({ error: 'deployment_unavailable', state: 'waking' })
  })

  it('reloads on the ready-route 502 body', async () => {
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(502, { error: 'The request could not reach your workspace. Please retry.' }),
    )
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not reload other 503s', async () => {
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, { error: 'wake_unavailable' }))
    expect(reload).not.toHaveBeenCalled()
    expect(isWorkspaceUnavailableReloadPending()).toBe(false)
  })

  it('does not reload 401s', async () => {
    await maybeReloadForWorkspaceUnavailable(jsonResponse(401, { error: 'deployment_unavailable' }))
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload in Electron, where a renderer reload misses the ingress waiting page', async () => {
    ;(window as { electronAPI?: object }).electronAPI = {}
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, { error: 'deployment_unavailable' }))
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload again inside the cooldown', async () => {
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, { error: 'deployment_unavailable' }))
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, { error: 'deployment_unavailable' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('trusts the header without reading the body', async () => {
    const response = new Response('not json', {
      status: 503,
      headers: { [WORKSPACE_UNAVAILABLE_HEADER]: 'waking' },
    })
    await maybeReloadForWorkspaceUnavailable(response)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads on a header-tagged unreachable 502', async () => {
    await maybeReloadForWorkspaceUnavailable(jsonResponse(502, {}, 'unreachable'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('prompts instead of reloading when the workspace is sleeping (header)', async () => {
    const notify = vi.fn()
    subscribeWorkspaceAsleep(notify)
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(503, { error: 'deployment_unavailable', state: 'sleeping' }, 'sleeping'),
    )
    expect(reload).not.toHaveBeenCalled()
    expect(isWorkspaceAsleep()).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('prompts instead of reloading when the workspace is sleeping (body fallback)', async () => {
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(503, { error: 'deployment_unavailable', state: 'sleeping' }),
    )
    expect(reload).not.toHaveBeenCalled()
    expect(isWorkspaceAsleep()).toBe(true)
  })

  it('prompts on the error state too', async () => {
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(503, { error: 'deployment_unavailable', state: 'error' }, 'error'),
    )
    expect(reload).not.toHaveBeenCalled()
    expect(isWorkspaceAsleep()).toBe(true)
  })

  it('notifies each asleep listener at most once', async () => {
    const notify = vi.fn()
    subscribeWorkspaceAsleep(notify)
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'sleeping'))
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'sleeping'))
    expect(notify).toHaveBeenCalledOnce()
  })
})

describe('isWorkspaceUnavailableError', () => {
  it('is true only for the ingress error strings', () => {
    expect(isWorkspaceUnavailableError('deployment_unavailable')).toBe(true)
    expect(isWorkspaceUnavailableError('Auth config unavailable')).toBe(false)
    expect(isWorkspaceUnavailableError(null)).toBe(false)
  })
})

