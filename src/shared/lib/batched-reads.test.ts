import { describe, expect, it } from 'vitest'
import { batchModuleOf, isBatchableRead } from './batched-reads'

describe('batchModuleOf', () => {
  it.each([
    ['/api/agents/sales/hooks', 'agent-sections'],
    ['/api/agents/sales/scheduled-tasks?status=pending', 'agent-sections'],
    ['/api/agents/sales/scheduled-tasks/completed-sessions', 'agent-sections'],
    ['/api/activity/agents/sales?days=14&tz=480', 'agent-sections'],
    ['/api/agent-integrations/agents/sales', 'agent-sections'],
    ['/api/volume-definitions', 'agent-sections'],
    ['/api/llm-connections', 'composer-options'],
    ['/api/llm-connections/legacy-platform/model-availability', 'composer-options'],
    ['/api/agents/sales/preferences', 'composer-options'],
    ['/api/agents/sales/sessions/s1/llm-connections', 'composer-options'],
    ['/api/agents/sales/bookmarks', 'agent-cards'],
    ['/api/agents/sales/widgets', 'agent-cards'],
  ])('puts %s in the %s module', (path, module) => {
    expect(batchModuleOf(path)).toBe(module)
  })

  it.each([
    // A page's main content: each read goes by itself.
    '/api/agents',
    '/api/agents/sales',
    '/api/agents/sales/sessions',
    '/api/agents/sales/sessions/s1',
    '/api/agents/sales/sessions/s1/messages',
    '/api/agents/sales/pending-requests',
    '/api/user-settings',
    '/api/settings',
    // Streams and bytes.
    '/api/notifications/stream',
    '/api/agents/sales/files/report.pdf',
    // Not a read of a page's data.
    '/api/auth/get-session',
    '/api/batch-reads',
    // Outside the API, or another origin.
    '/agents/sales/hooks',
    'https://example.com/api/volume-definitions',
  ])('leaves %s to go by itself', (path) => {
    expect(batchModuleOf(path)).toBeNull()
    expect(isBatchableRead(path)).toBe(false)
  })

  it('leaves out a path that names another route once normalized', () => {
    expect(batchModuleOf('/api/agents/../volume-definitions')).toBeNull()
    expect(batchModuleOf('/api/agents/sales/../../agents/sales/hooks')).toBeNull()
  })
})
