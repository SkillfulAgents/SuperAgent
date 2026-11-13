import { describe, expect, it } from 'vitest'
import { isBatchableRead } from './batched-reads'

describe('isBatchableRead', () => {
  it.each([
    '/api/agents',
    '/api/user-settings',
    '/api/llm-connections/legacy-platform/model-availability',
    '/api/agents/sales',
    '/api/agents/sales/sessions',
    '/api/agents/sales/scheduled-tasks?status=pending',
    '/api/agents/sales/scheduled-tasks/completed-sessions',
    '/api/agents/sales/sessions/s1',
    '/api/agents/sales/sessions/s1/llm-connections',
    '/api/activity/agents/sales?days=14&tz=480',
    '/api/agent-integrations/agents/sales',
    '/api/agent-integrations/agents/sales/sessions/s1',
  ])('takes the page read %s', (path) => {
    expect(isBatchableRead(path)).toBe(true)
  })

  it.each([
    // Large, streamed, or bytes.
    '/api/agents/sales/sessions/s1/messages',
    '/api/agents/sales/sessions/s1/stream',
    '/api/notifications/stream',
    '/api/agents/sales/files/report.pdf',
    // Not a read of a page's data.
    '/api/auth/get-session',
    '/api/batch-reads',
    '/api/agents/sales/unknown',
    // Outside the API, or another origin.
    '/agents/sales',
    'https://example.com/api/agents',
  ])('leaves out %s', (path) => {
    expect(isBatchableRead(path)).toBe(false)
  })

  it('leaves out a path that names another route once normalized', () => {
    expect(isBatchableRead('/api/agents/../settings')).toBe(false)
    expect(isBatchableRead('/api/agents/sales/../../auth/get-session')).toBe(false)
  })
})
