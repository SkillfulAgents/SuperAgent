// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'
import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
} from '@shared/lib/dashboard-dispatch-schema'
import {
  DASHBOARD_DISPATCH_COOLDOWN_MS,
  useDashboardDispatch,
} from './use-dashboard-dispatch'

function makeFrame() {
  const contentWindow = { postMessage: vi.fn() }
  const frame = {
    contentWindow,
    src: 'http://127.0.0.1:3000/api/agents/a/artifacts/dash/',
  }
  return { frame, contentWindow }
}

function sendFromSource(source: unknown, data: unknown) {
  const event = new MessageEvent('message', { data })
  // jsdom's MessageEventInit refuses arbitrary objects as `source`; shadow the
  // prototype getter instead.
  Object.defineProperty(event, 'source', { value: source })
  act(() => {
    window.dispatchEvent(event)
  })
}

function validRequest(id: string, prompt = '/research-user jane') {
  return {
    type: DASHBOARD_DISPATCH_REQUEST_TYPE,
    id,
    payload: { prompt, title: 'Research Jane' },
  }
}

describe('useDashboardDispatch', () => {
  let frame: ReturnType<typeof makeFrame>['frame']
  let contentWindow: ReturnType<typeof makeFrame>['contentWindow']
  let iframeRef: RefObject<HTMLIFrameElement | null>

  beforeEach(() => {
    vi.useFakeTimers()
    ;({ frame, contentWindow } = makeFrame())
    iframeRef = { current: frame as unknown as HTMLIFrameElement }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function postedMessages() {
    return contentWindow.postMessage.mock.calls.map(([message, targetOrigin]) => ({
      message: message as Record<string, unknown>,
      targetOrigin: targetOrigin as string,
    }))
  }

  it('acks a valid request, surfaces it as pending, and targets the iframe origin', () => {
    const { result } = renderHook(() => useDashboardDispatch(iframeRef))

    sendFromSource(contentWindow, validRequest('r1'))

    expect(result.current.pending).toEqual({
      id: 'r1',
      prompt: '/research-user jane',
      title: 'Research Jane',
    })
    const posted = postedMessages()
    expect(posted).toHaveLength(1)
    expect(posted[0].message).toEqual({ type: DASHBOARD_DISPATCH_ACK_TYPE, id: 'r1' })
    expect(posted[0].targetOrigin).toBe('http://127.0.0.1:3000')
  })

  it('ignores messages that are not from this view\'s iframe', () => {
    const { result } = renderHook(() => useDashboardDispatch(iframeRef))

    sendFromSource({ postMessage: vi.fn() }, validRequest('r1'))

    expect(result.current.pending).toBeNull()
    expect(contentWindow.postMessage).not.toHaveBeenCalled()
  })

  it('replies invalid_request to a malformed request that still carries an id', () => {
    const { result } = renderHook(() => useDashboardDispatch(iframeRef))

    sendFromSource(contentWindow, {
      type: DASHBOARD_DISPATCH_REQUEST_TYPE,
      id: 'bad-1',
      payload: { prompt: '' },
    })

    expect(result.current.pending).toBeNull()
    const posted = postedMessages()
    expect(posted[posted.length - 1].message).toMatchObject({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'bad-1',
      result: { code: 'invalid_request' },
    })
  })

  it('refuses a second request as busy while one is pending', () => {
    const { result } = renderHook(() => useDashboardDispatch(iframeRef))

    sendFromSource(contentWindow, validRequest('r1'))
    sendFromSource(contentWindow, validRequest('r2'))

    expect(result.current.pending?.id).toBe('r1')
    const posted = postedMessages()
    expect(posted[posted.length - 1].message).toMatchObject({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r2',
      result: { code: 'busy' },
    })
  })

  it('posts the resolution, applies a cooldown, then accepts requests again', () => {
    const { result } = renderHook(() => useDashboardDispatch(iframeRef))

    sendFromSource(contentWindow, validRequest('r1'))
    act(() => {
      result.current.resolvePending({ sessionId: 's-1', agentSlug: 'a' })
    })

    expect(result.current.pending).toBeNull()
    let posted = postedMessages()
    expect(posted[posted.length - 1].message).toEqual({
      type: DASHBOARD_DISPATCH_RESULT_TYPE,
      id: 'r1',
      result: { sessionId: 's-1', agentSlug: 'a' },
    })

    sendFromSource(contentWindow, validRequest('r2'))
    expect(result.current.pending).toBeNull()
    posted = postedMessages()
    expect(posted[posted.length - 1].message).toMatchObject({
      id: 'r2',
      result: { code: 'rate_limited' },
    })

    act(() => {
      vi.advanceTimersByTime(DASHBOARD_DISPATCH_COOLDOWN_MS + 1)
    })
    sendFromSource(contentWindow, validRequest('r3'))
    expect(result.current.pending?.id).toBe('r3')
  })
})
