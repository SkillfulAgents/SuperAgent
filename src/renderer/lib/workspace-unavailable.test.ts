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
  subscribeWorkspaceUnavailable,
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
    expect(
      workspaceUnavailableBodySchema.safeParse({
        error: 'deployment_unavailable',
        state: 'waking',
      }).success,
    ).toBe(true)
  })

  it('rejects the ambiguous legacy 502 body', () => {
    expect(
      workspaceUnavailableBodySchema.safeParse({
        error: 'The request could not reach your workspace. Please retry.',
      }).success,
    ).toBe(false)
  })

  it('rejects an unrelated error string', () => {
    expect(workspaceUnavailableBodySchema.safeParse({ error: 'Auth config unavailable' }).success).toBe(false)
  })

  it('rejects missing or unknown route states', () => {
    expect(workspaceUnavailableBodySchema.safeParse({ error: 'deployment_unavailable' }).success).toBe(false)
    expect(
      workspaceUnavailableBodySchema.safeParse({
        error: 'deployment_unavailable',
        state: 'future-state',
      }).success,
    ).toBe(false)
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

  it('does not reload on the ambiguous legacy 502 body', async () => {
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(502, { error: 'The request could not reach your workspace. Please retry.' }),
    )
    expect(reload).not.toHaveBeenCalled()
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
    const unavailable = { error: 'deployment_unavailable', state: 'waking' }
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, unavailable))
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, unavailable))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not schedule a later reload after the cooldown — ingress waits for ready', async () => {
    vi.useFakeTimers()
    try {
      const unavailable = { error: 'deployment_unavailable', state: 'waking' }
      await maybeReloadForWorkspaceUnavailable(jsonResponse(503, unavailable))
      await maybeReloadForWorkspaceUnavailable(jsonResponse(503, unavailable))
      expect(reload).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a success drops the overlay and does not reload later', async () => {
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'waking'))
    expect(isWorkspaceUnavailableReloadPending()).toBe(true)
    await maybeReloadForWorkspaceUnavailable(new Response('ok', { status: 200 }))
    expect(isWorkspaceUnavailableReloadPending()).toBe(false)
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

  it('ignores an unknown header state', async () => {
    await maybeReloadForWorkspaceUnavailable(
      jsonResponse(503, { error: 'deployment_unavailable', state: 'waking' }, 'future-state'),
    )
    expect(reload).not.toHaveBeenCalled()
    expect(isWorkspaceAsleep()).toBe(false)
  })

  it('prompts instead of reloading when the workspace is sleeping (header)', async () => {
    const notify = vi.fn()
    subscribeWorkspaceUnavailable(notify)
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
    subscribeWorkspaceUnavailable(notify)
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'sleeping'))
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'sleeping'))
    expect(notify).toHaveBeenCalledOnce()
  })

  it('notifies subscribers when a reload becomes pending', async () => {
    const notify = vi.fn()
    subscribeWorkspaceUnavailable(notify)
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'waking'))
    expect(isWorkspaceUnavailableReloadPending()).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('clears the asleep prompt when a later request succeeds', async () => {
    const notify = vi.fn()
    await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'sleeping'))
    expect(isWorkspaceAsleep()).toBe(true)
    subscribeWorkspaceUnavailable(notify)
    await maybeReloadForWorkspaceUnavailable(new Response('ok', { status: 200 }))
    expect(isWorkspaceAsleep()).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('a success without a prior prompt notifies nobody', async () => {
    const notify = vi.fn()
    subscribeWorkspaceUnavailable(notify)
    await maybeReloadForWorkspaceUnavailable(new Response('ok', { status: 200 }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('still reloads when sessionStorage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      await maybeReloadForWorkspaceUnavailable(jsonResponse(503, {}, 'waking'))
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })
})

describe('isWorkspaceUnavailableError', () => {
  it('is true only for the ingress error strings', () => {
    expect(isWorkspaceUnavailableError('deployment_unavailable')).toBe(true)
    expect(isWorkspaceUnavailableError('Auth config unavailable')).toBe(false)
    expect(isWorkspaceUnavailableError(null)).toBe(false)
  })
})

