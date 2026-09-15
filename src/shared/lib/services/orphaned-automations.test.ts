import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsAuthMode = vi.fn(() => true)
const mockUserExists = vi.fn((_userId: string) => true)
const mockPauseTasks = vi.fn(async (_userId: string) => 2)
const mockPauseTriggers = vi.fn(async (_userId: string) => 1)
const mockCaptureMessage = vi.fn()

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => mockIsAuthMode() }))
vi.mock('./user-profile-service', () => ({ userExists: (userId: string) => mockUserExists(userId) }))
vi.mock('./scheduled-task-service', () => ({
  pauseScheduledTasksCreatedBy: (userId: string) => mockPauseTasks(userId),
}))
vi.mock('./webhook-trigger-service', () => ({
  pauseWebhookTriggersCreatedBy: (userId: string) => mockPauseTriggers(userId),
}))
vi.mock('@shared/lib/error-reporting', () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}))

import { isOrphanedCreator, pauseAutomationsForUser, pauseOrphanedAutomations } from './orphaned-automations'

beforeEach(() => {
  vi.clearAllMocks()
  mockIsAuthMode.mockReturnValue(true)
  mockUserExists.mockReturnValue(true)
})

describe('isOrphanedCreator', () => {
  it('is true only for a non-empty creator that no longer exists in auth mode', () => {
    mockUserExists.mockReturnValue(false)
    expect(isOrphanedCreator('user_gone')).toBe(true)
    expect(mockUserExists).toHaveBeenCalledWith('user_gone')
  })

  it('is false when the creator still exists', () => {
    expect(isOrphanedCreator('user_alive')).toBe(false)
  })

  it('is false for a missing creator id without touching the DB', () => {
    expect(isOrphanedCreator(null)).toBe(false)
    expect(isOrphanedCreator(undefined)).toBe(false)
    expect(isOrphanedCreator('')).toBe(false)
    expect(mockUserExists).not.toHaveBeenCalled()
  })

  it('is false outside auth mode without touching the DB', () => {
    mockIsAuthMode.mockReturnValue(false)
    mockUserExists.mockReturnValue(false)
    expect(isOrphanedCreator('user_gone')).toBe(false)
    expect(mockUserExists).not.toHaveBeenCalled()
  })
})

describe('pauseAutomationsForUser', () => {
  it('pauses both tasks and triggers for the user and returns the counts', async () => {
    await expect(pauseAutomationsForUser('user_gone')).resolves.toEqual({ scheduledTasks: 2, webhookTriggers: 1 })
    expect(mockPauseTasks).toHaveBeenCalledWith('user_gone')
    expect(mockPauseTriggers).toHaveBeenCalledWith('user_gone')
  })
})

describe('pauseOrphanedAutomations', () => {
  it('pauses, then reports once with the source and row context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await pauseOrphanedAutomations('user_gone', 'scheduled_task', { taskId: 'task_1', agentSlug: 'agent-x' })
    } finally {
      warn.mockRestore()
    }
    expect(mockPauseTasks).toHaveBeenCalledWith('user_gone')
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1)
    expect(mockCaptureMessage).toHaveBeenCalledWith('automation creator no longer exists; paused', {
      level: 'warning',
      tags: { area: 'automations', op: 'orphaned_creator.scheduled_task' },
      extra: { createdByUserId: 'user_gone', scheduledTasks: 2, webhookTriggers: 1, taskId: 'task_1', agentSlug: 'agent-x' },
    })
  })
})
