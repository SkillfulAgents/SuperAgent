import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCallBrainHost = vi.fn()

vi.mock('./host-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-client')>()
  return {
    ...actual,
    callBrainHost: (...args: unknown[]) => mockCallBrainHost(...args),
  }
})

import { executeBrainRead } from './read'

describe('executeBrainRead', () => {
  beforeEach(() => {
    mockCallBrainHost.mockReset()
  })

  it('returns the page body', async () => {
    mockCallBrainHost.mockResolvedValue({
      found: true,
      name: 'INDEX.md',
      description: 'Team Brain',
      body: '# Team Brain\n',
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const result = await executeBrainRead('INDEX.md')
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('# Team Brain\n')
  })

  it('surfaces a host failure as a tool error', async () => {
    const { BrainHostError } = await import('./host-client')
    mockCallBrainHost.mockRejectedValue(new BrainHostError(404, 'Team Brain is off'))
    const result = await executeBrainRead('INDEX.md')
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Failed to read brain page: Team Brain is off')
  })

  it('returns not found without treating it as a tool error', async () => {
    mockCallBrainHost.mockResolvedValue({ found: false, suggestions: [] })
    const result = await executeBrainRead('missing-page')
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Page not found.')
  })
})
