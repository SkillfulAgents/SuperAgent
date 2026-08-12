// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { addRendererBreadcrumb } = vi.hoisted(() => ({ addRendererBreadcrumb: vi.fn() }))
vi.mock('./error-reporting', () => ({ addRendererBreadcrumb }))

import {
  ApiRequestError,
  beginApiRequest,
  classifyApiOrigin,
  rememberResponseContext,
  resetApiObservabilityForTest,
  sanitizeRouteTemplate,
  throwApiResponseError,
} from './api-observability'

describe('renderer API observability', () => {
  beforeEach(() => {
    addRendererBreadcrumb.mockClear()
    resetApiObservabilityForTest()
  })

  it('templates IDs and strips query values, tokens, and full URLs', () => {
    const input = '/api/agents/alice-agent-a1b2c3d4e5/sessions/session-secret/messages?token=secret&email=user@example.com'
    const route = sanitizeRouteTemplate(input)

    expect(route).toBe('/api/agents/:id/sessions/:id/messages')
    expect(route).not.toContain('alice')
    expect(route).not.toContain('secret')
    expect(route).not.toContain('@')
  })

  it('classifies API origins without retaining hosts, ports, or paths', () => {
    expect(classifyApiOrigin('')).toBe('same-origin')
    expect(classifyApiOrigin('http://localhost:54321')).toBe('loopback')
    expect(classifyApiOrigin('http://127.0.0.1:54321/cloud/key')).toBe('cloud-proxy')
    expect(classifyApiOrigin('https://private.example/user/path?token=x')).toBe('remote')
  })

  it('records bounded HTTP context and only accepts safe code/request IDs', async () => {
    const request = beginApiRequest(
      '/api/agents/private-id/preferences?token=secret',
      undefined,
      'http://localhost:54321',
      'fetch-agent-preferences',
    )
    const response = new Response(JSON.stringify({
      code: 'preferences_unavailable',
      error: 'private preference value',
      token: 'secret',
    }), {
      status: 503,
      headers: { 'x-request-id': 'request_AbC12345', 'content-type': 'application/json' },
    })
    rememberResponseContext(response, request.finish(response))

    let caught: ApiRequestError | undefined
    try {
      await throwApiResponseError(response, 'fetch-agent-preferences')
    } catch (error) {
      caught = error as ApiRequestError
    }

    expect(caught).toBeInstanceOf(ApiRequestError)
    expect(caught?.context).toMatchObject({
      routeTemplate: '/api/agents/:id/preferences',
      operation: 'fetch-agent-preferences',
      originClass: 'loopback',
      status: 503,
      code: 'preferences_unavailable',
      requestId: 'request_AbC12345',
    })
    const serialized = JSON.stringify(caught?.context)
    expect(serialized).not.toContain('private-id')
    expect(serialized).not.toContain('private preference value')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('54321')
  })

  it('normalizes network rejection and breadcrumbs concurrent failure streaks', () => {
    const first = beginApiRequest('/api/settings', undefined, '', 'fetch-settings')
    const second = beginApiRequest('/api/settings', undefined, '', 'fetch-settings')

    const one = first.fail(new TypeError('Failed to fetch https://secret.example/?token=x'))
    const two = second.fail(new TypeError('Failed to fetch https://secret.example/?token=x'))

    expect(one.transport).toBe('network')
    expect(one.failureStreak).toBe(1)
    expect(two.failureStreak).toBe(2)
    expect(JSON.stringify(addRendererBreadcrumb.mock.calls)).not.toContain('secret.example')
    expect(JSON.stringify(addRendererBreadcrumb.mock.calls)).not.toContain('token=x')
  })
})
