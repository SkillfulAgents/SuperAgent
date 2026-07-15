import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockGetScheduledTask = vi.fn()
const mockCancelScheduledTask = vi.fn()
const mockResetScheduledTask = vi.fn()
const mockUpdateTaskTimezone = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockRecordManualExecution = vi.fn()
const mockUpdateScheduleExpression = vi.fn()
const mockUpdateTaskPrompt = vi.fn()
const mockUpdateTaskName = vi.fn()
const mockUpdateTaskRuntimeOptions = vi.fn()
const mockPauseScheduledTask = vi.fn()
const mockResumeScheduledTask = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  cancelScheduledTask: (...args: unknown[]) => mockCancelScheduledTask(...args),
  resetScheduledTask: (...args: unknown[]) => mockResetScheduledTask(...args),
  updateTaskTimezone: (...args: unknown[]) => mockUpdateTaskTimezone(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  recordManualExecution: (...args: unknown[]) => mockRecordManualExecution(...args),
  updateScheduleExpression: (...args: unknown[]) => mockUpdateScheduleExpression(...args),
  updateTaskPrompt: (...args: unknown[]) => mockUpdateTaskPrompt(...args),
  updateTaskName: (...args: unknown[]) => mockUpdateTaskName(...args),
  updateTaskRuntimeOptions: (...args: unknown[]) => mockUpdateTaskRuntimeOptions(...args),
  pauseScheduledTask: (...args: unknown[]) => mockPauseScheduledTask(...args),
  resumeScheduledTask: (...args: unknown[]) => mockResumeScheduledTask(...args),
}))

const mockGetSessionsByScheduledTask = vi.fn()
const mockRegisterSession = vi.fn()
const mockUpdateSessionMetadata = vi.fn()
const mockGetSessionMetadata = vi.fn((..._args: unknown[]) => Promise.resolve({ name: 'Sleeping session' }))

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionsByScheduledTask: (...args: unknown[]) => mockGetSessionsByScheduledTask(...args),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: () => Promise.resolve(true),
}))

const mockTriggerScheduledSessionResumed = vi.fn((..._args: unknown[]) => Promise.resolve())

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerScheduledSessionResumed: (...args: unknown[]) =>
      mockTriggerScheduledSessionResumed(...args),
  },
}))

const mockGetSecretEnvVars = vi.fn()

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: (...args: unknown[]) => mockGetSecretEnvVars(...args),
}))

const mockCreateSession = vi.fn()
const mockEnsureRunning = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

const mockMessagePersister = vi.hoisted(() => ({
  isSessionActive: vi.fn(),
  subscribeToSession: vi.fn(),
  markSessionActive: vi.fn(),
  markSessionIdle: vi.fn(),
  isSubscribed: vi.fn(() => false),
  cancelAwaitingInput: vi.fn(() => Promise.resolve()),
  broadcastGlobal: vi.fn(),
  broadcastSessionUpdate: vi.fn(),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: mockMessagePersister,
}))

const mockGetEffectiveModels = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: (...args: unknown[]) => mockGetEffectiveModels(...args),
  // resolveActiveProviderModel (host-direct summarizer resolution) reads the
  // active provider via getSettings; default to anthropic for the catalog.
  getSettings: () => ({ llmProvider: 'anthropic' }),
  getModelCatalogSettings: () => ({}),
}))

const mockReadAgentPreferences = vi.fn()

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (...args: unknown[]) => mockReadAgentPreferences(...args),
}))

const mockValidateCronExpression = vi.fn()
const mockGetFrequencyWarning = vi.fn()

vi.mock('@shared/lib/services/schedule-parser', () => ({
  validateCronExpression: (...args: unknown[]) => mockValidateCronExpression(...args),
  getFrequencyWarning: (...args: unknown[]) => mockGetFrequencyWarning(...args),
}))

const mockMessagesCreate = vi.fn()
const mockExtractTextFromLlmResponse = vi.fn()

vi.mock('@shared/lib/llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
    },
  }),
  extractTextFromLlmResponse: (...args: unknown[]) => mockExtractTextFromLlmResponse(...args),
  createSummarizerText: async (_client: unknown, request: unknown) =>
    mockExtractTextFromLlmResponse(await mockMessagesCreate(request)),
}))

const mockWithRetry = vi.fn(async (fn: () => Promise<unknown>) => fn())

vi.mock('@shared/lib/utils/retry', () => ({
  withRetry: (...args: Parameters<typeof mockWithRetry>) => mockWithRetry(...args),
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'test-user',
}))

const mockLogAuditEvent = vi.fn()

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  EntityAgentRole: (opts: {
    paramName: string
    lookupFn: (id: string) => Promise<unknown>
    contextKey: string
    entityName: string
  }) => () => async (c: {
    req: { param: (name: string) => string }
    set: (key: string, value: unknown) => void
    json: (body: unknown, status?: number) => Response
  }, next: () => Promise<void>) => {
    const entity = await opts.lookupFn(c.req.param(opts.paramName))
    if (!entity) {
      return c.json({ error: `${opts.entityName} not found` }, 404)
    }
    c.set(opts.contextKey, entity)
    return next()
  },
}))

import scheduledTasksRouter from './scheduled-tasks'

function createApp() {
  const app = new Hono()
  app.route('/api/scheduled-tasks', scheduledTasksRouter)
  return app
}

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    name: 'Daily report',
    prompt: 'Summarize yesterday',
    scheduleType: 'cron',
    scheduleExpression: '0 9 * * 1-5',
    status: 'pending',
    isRecurring: true,
    model: null,
    effort: null,
    speed: null,
    ...overrides,
  }
}

describe('scheduled-tasks route', () => {
  let app: ReturnType<typeof createApp>
  let task: ReturnType<typeof createTask>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    task = createTask()

    mockGetScheduledTask.mockImplementation(async () => task)
    mockGetSessionsByScheduledTask.mockResolvedValue([
      { id: 'session-active', name: 'Active session' },
      { id: 'session-idle', name: 'Idle session' },
    ])
    mockMessagePersister.isSessionActive.mockImplementation((sessionId: string) => sessionId === 'session-active')
    mockCreateSession.mockResolvedValue({ id: 'container-session-1' })
    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockGetSecretEnvVars.mockResolvedValue(['GITHUB_TOKEN'])
    mockGetEffectiveModels.mockReturnValue({
      agentModel: 'claude-agent',
      browserModel: 'claude-browser',
      summarizerModel: 'claude-haiku-4-5',
    })
    mockReadAgentPreferences.mockResolvedValue({})
    mockValidateCronExpression.mockReturnValue({ valid: true })
    mockGetFrequencyWarning.mockReturnValue(null)
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Every weekday at 9:00 AM' }] })
    mockExtractTextFromLlmResponse.mockReturnValue('Every weekday at 9:00 AM')
    mockPauseScheduledTask.mockResolvedValue(true)
    mockResumeScheduledTask.mockResolvedValue(true)
    mockUpdateScheduleExpression.mockResolvedValue(true)
    mockUpdateTaskName.mockResolvedValue(true)
  })

  it('returns task sessions with live activity from the message persister', async () => {
    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/sessions')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: 'session-active', name: 'Active session', isActive: true },
      { id: 'session-idle', name: 'Idle session', isActive: false },
    ])
    expect(mockGetSessionsByScheduledTask).toHaveBeenCalledWith('agent-one', 'task-1')
  })

  it('runs a recurring task immediately and records a manual execution', async () => {
    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/run-now', {
      method: 'POST',
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      sessionId: 'container-session-1',
      agentSlug: 'agent-one',
      task,
    })
    expect(mockEnsureRunning).toHaveBeenCalledWith('agent-one')
    expect(mockCreateSession).toHaveBeenCalledWith({
      availableEnvVars: ['GITHUB_TOKEN'],
      initialMessage: 'Summarize yesterday',
      model: 'claude-agent',
      browserModel: 'claude-browser',
    })
    expect(mockRegisterSession).toHaveBeenCalledWith('agent-one', 'container-session-1', 'Daily report')
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith('agent-one', 'container-session-1', {
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      scheduledTaskName: 'Daily report',
    })
    expect(mockMessagePersister.subscribeToSession).toHaveBeenCalledWith(
      'container-session-1',
      { createSession: mockCreateSession },
      'container-session-1',
      'agent-one',
    )
    expect(mockMessagePersister.markSessionActive).toHaveBeenCalledWith('container-session-1', 'agent-one')
    expect(mockRecordManualExecution).toHaveBeenCalledWith('task-1', 'container-session-1')
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
  })

  it('marks a one-time task executed when run-now succeeds', async () => {
    task = createTask({ isRecurring: false, scheduleType: 'once', name: null, model: 'custom-model', effort: 'high' })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/run-now', {
      method: 'POST',
    })

    expect(res.status).toBe(201)
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'custom-model',
      effort: 'high',
    }))
    expect(mockRegisterSession).toHaveBeenCalledWith('agent-one', 'container-session-1', 'Scheduled Task (Run Now)')
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('task-1', 'container-session-1')
    expect(mockRecordManualExecution).not.toHaveBeenCalled()
  })

  describe('session wakes (resume tasks)', () => {
    function createWakeTask(overrides: Record<string, unknown> = {}) {
      return createTask({
        scheduleType: 'at',
        scheduleExpression: 'at tomorrow 9am',
        isRecurring: false,
        name: null,
        prompt: 'Check whether Dana replied',
        resumeSessionId: 'sleeping-session-1',
        createdBySessionId: 'sleeping-session-1',
        nextExecutionAt: new Date('2027-01-01T09:00:00.000Z'),
        createdAt: new Date('2026-12-30T09:00:00.000Z'),
        timezone: null,
        ...overrides,
      })
    }

    it('run-now resumes the target session instead of creating a new one', async () => {
      task = createWakeTask()
      const mockSendMessage = vi.fn()
      mockEnsureRunning.mockResolvedValue({
        createSession: mockCreateSession,
        sendMessage: mockSendMessage,
      })

      const res = await app.request('http://localhost/api/scheduled-tasks/task-1/run-now', {
        method: 'POST',
      })

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.sessionId).toBe('sleeping-session-1')

      expect(mockCreateSession).not.toHaveBeenCalled()
      expect(mockRegisterSession).not.toHaveBeenCalled()

      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      const [sessionId, content, , options] = mockSendMessage.mock.calls[0]
      expect(sessionId).toBe('sleeping-session-1')
      expect(content.startsWith('[SYSTEM] ')).toBe(true)
      expect(content).toContain('Check whether Dana replied')
      expect(options).toEqual({ shouldQuery: true })

      expect(mockUpdateSessionMetadata).toHaveBeenCalledWith(
        'agent-one',
        'sleeping-session-1',
        expect.objectContaining({
          lastWake: expect.objectContaining({ taskId: 'task-1' }),
        })
      )
      expect(mockMarkTaskExecuted).toHaveBeenCalledWith('task-1', 'sleeping-session-1')
      expect(mockMessagePersister.broadcastGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_updated', sessionId: 'sleeping-session-1' })
      )
    })

    it('cancelling a wake broadcasts session_updated so badges clear', async () => {
      task = createWakeTask()
      mockCancelScheduledTask.mockResolvedValue(true)

      const res = await app.request('http://localhost/api/scheduled-tasks/task-1', {
        method: 'DELETE',
      })

      expect(res.status).toBe(204)
      expect(mockMessagePersister.broadcastGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_updated', sessionId: 'sleeping-session-1' })
      )
    })

    it('cancelling a regular task does not broadcast session_updated', async () => {
      task = createTask()
      mockCancelScheduledTask.mockResolvedValue(true)

      const res = await app.request('http://localhost/api/scheduled-tasks/task-1', {
        method: 'DELETE',
      })

      expect(res.status).toBe(204)
      expect(mockMessagePersister.broadcastGlobal).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_updated' })
      )
    })
  })

  describe('run-now model, effort, and speed resolution', () => {
    // Preference order: task override > agent default > global default.
    async function runNow(overrides: Record<string, unknown> = {}) {
      task = createTask(overrides)
      const res = await app.request('http://localhost/api/scheduled-tasks/task-1/run-now', {
        method: 'POST',
      })
      expect(res.status).toBe(201)
      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      return mockCreateSession.mock.calls[0][0]
    }

    it('uses the global default when neither task nor agent set one', async () => {
      const args = await runNow()
      expect(args.model).toBe('claude-agent')
      expect(args.effort).toBeUndefined()
      expect(args.speed).toBeUndefined()
    })

    it('falls back to the agent default over the global default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high', defaultSpeed: 'slow' })
      const args = await runNow()
      expect(mockReadAgentPreferences).toHaveBeenCalledWith('agent-one')
      expect(args.model).toBe('opus')
      expect(args.effort).toBe('high')
      expect(args.speed).toBe('slow')
    })

    it('prefers the task override over the agent default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high', defaultSpeed: 'fast' })
      const args = await runNow({ model: 'claude-haiku-4-5-20251001', effort: 'low', speed: 'slow' })
      expect(args.model).toBe('claude-haiku-4-5-20251001')
      expect(args.effort).toBe('low')
      expect(args.speed).toBe('slow')
    })

    it('a stored normal speed override beats a non-normal agent default', async () => {
      mockReadAgentPreferences.mockResolvedValue({ defaultSpeed: 'fast' })
      const args = await runNow({ speed: 'normal' })
      expect(args.speed).toBe('normal')
    })
  })

  describe('runtime-options PATCH contract', () => {
    async function patchRuntimeOptions(body: Record<string, unknown>) {
      return app.request('http://localhost/api/scheduled-tasks/task-1/runtime-options', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('updates model, effort, and speed', async () => {
      mockUpdateTaskRuntimeOptions.mockResolvedValue(true)

      const res = await patchRuntimeOptions({ model: 'claude-haiku-4-5', effort: 'low', speed: 'slow' })

      expect(res.status).toBe(200)
      expect(mockUpdateTaskRuntimeOptions).toHaveBeenCalledWith('task-1', {
        model: 'claude-haiku-4-5',
        effort: 'low',
        speed: 'slow',
      })
    })

    it('accepts a speed-only update', async () => {
      mockUpdateTaskRuntimeOptions.mockResolvedValue(true)

      const res = await patchRuntimeOptions({ speed: 'fast' })

      expect(res.status).toBe(200)
      expect(mockUpdateTaskRuntimeOptions).toHaveBeenCalledWith('task-1', { speed: 'fast' })
    })

    it('clears speed back to the default via null', async () => {
      mockUpdateTaskRuntimeOptions.mockResolvedValue(true)

      const res = await patchRuntimeOptions({ speed: null })

      expect(res.status).toBe(200)
      expect(mockUpdateTaskRuntimeOptions).toHaveBeenCalledWith('task-1', { speed: null })
    })

    it('rejects an invalid speed value', async () => {
      const res = await patchRuntimeOptions({ speed: 'ludicrous' })

      expect(res.status).toBe(400)
      expect(mockUpdateTaskRuntimeOptions).not.toHaveBeenCalled()
    })
  })

  it('does not start a container for non-runnable task statuses', async () => {
    task = createTask({ status: 'cancelled' })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/run-now', {
      method: 'POST',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Task is not pending' })
    expect(mockEnsureRunning).not.toHaveBeenCalled()
  })

  it('rejects invalid cron updates before mutating the schedule', async () => {
    mockValidateCronExpression.mockReturnValue({ valid: false })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleExpression: 'not cron' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cron expression' })
    expect(mockUpdateScheduleExpression).not.toHaveBeenCalled()
  })

  it('appends a frequency warning when the new schedule is too frequent', async () => {
    mockGetFrequencyWarning.mockReturnValue('⚠️ Frequent schedule warning: every 1 minute')

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleExpression: '* * * * *' }),
    })

    expect(res.status).toBe(200)
    expect(mockGetFrequencyWarning).toHaveBeenCalledWith('cron', '* * * * *', undefined)
    expect(await res.json()).toMatchObject({
      id: 'task-1',
      warning: '⚠️ Frequent schedule warning: every 1 minute',
    })
  })

  it('omits the warning when the new schedule is not too frequent', async () => {
    mockGetFrequencyWarning.mockReturnValue(null)

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleExpression: '0 9 * * 1-5' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).not.toHaveProperty('warning')
  })

  it('renames a scheduled task title', async () => {
    mockUpdateTaskName.mockImplementation(async (_taskId: string, name: string) => {
      task = createTask({ name })
      return true
    })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/name', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  Weekly digest  ' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'task-1', name: 'Weekly digest' })
    expect(mockUpdateTaskName).toHaveBeenCalledWith('task-1', 'Weekly digest')
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      object: 'task',
      objectId: 'task-1',
      action: 'updated',
      details: { field: 'name' },
    }))
  })

  it('rejects blank scheduled task names', async () => {
    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/name', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'name is required and must be a non-empty string' })
    expect(mockUpdateTaskName).not.toHaveBeenCalled()
  })

  it('returns 404 when a scheduled task name cannot be updated', async () => {
    mockUpdateTaskName.mockResolvedValue(false)

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/name', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Weekly digest' }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Task not found or not editable' })
  })

  it('returns 422 when the LLM generates an invalid cron expression', async () => {
    mockExtractTextFromLlmResponse.mockReturnValue('every weekday morning')
    mockValidateCronExpression.mockReturnValue({ valid: false })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/parse-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Every weekday morning' }),
    })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'Generated expression is not valid cron syntax',
      expression: 'every weekday morning',
    })
    expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5',
    }))
  })

  it('only allows recurring cron tasks to be paused', async () => {
    task = createTask({ scheduleType: 'once', isRecurring: false })

    const res = await app.request('http://localhost/api/scheduled-tasks/task-1/pause', {
      method: 'POST',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Only recurring cron tasks can be paused' })
    expect(mockPauseScheduledTask).not.toHaveBeenCalled()
  })
})
