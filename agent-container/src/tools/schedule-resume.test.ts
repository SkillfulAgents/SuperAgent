import { describe, it, expect, vi, beforeEach } from 'vitest'
import { inputManager } from '../input-manager'

describe('scheduleResumeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Drain any toolUseId left over from a previous test
    inputManager.consumeCurrentToolUseId()
  })

  it('returns error when the note is empty', async () => {
    const { scheduleResumeTool } = await import('./schedule-resume')
    const handler = (scheduleResumeTool as any).handler

    const result = await handler({ wakeTime: 'tomorrow 9am', note: '   ' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('note')
  })

  it('returns error when the wakeTime is empty', async () => {
    const { scheduleResumeTool } = await import('./schedule-resume')
    const handler = (scheduleResumeTool as any).handler

    const result = await handler({ wakeTime: '  ', note: 'Check the email' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('wakeTime')
  })

  it('returns error when no toolUseId is available', async () => {
    const { scheduleResumeTool } = await import('./schedule-resume')
    const handler = (scheduleResumeTool as any).handler

    const result = await handler({ wakeTime: 'tomorrow 9am', note: 'Check the email' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no tool use ID available')
  })

  it('blocks on the host and returns the resolved confirmation', async () => {
    const toolUseId = `wake-test-${Date.now()}-1`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.resolve(toolUseId, 'Scheduled this session to auto-resume at 2027-01-01T09:00:00.000Z')

    const { scheduleResumeTool } = await import('./schedule-resume')
    const handler = (scheduleResumeTool as any).handler

    const result = await handler({ wakeTime: 'tomorrow 9am', note: 'Check the email' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('auto-resume')
  })

  it('surfaces a host rejection as a tool error', async () => {
    const toolUseId = `wake-test-${Date.now()}-2`
    inputManager.setCurrentToolUseId(toolUseId)
    inputManager.reject(toolUseId, new Error('Scheduled time "at yesterday" is in the past'))

    const { scheduleResumeTool } = await import('./schedule-resume')
    const handler = (scheduleResumeTool as any).handler

    const result = await handler({ wakeTime: 'yesterday', note: 'Impossible' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('in the past')
  })
})
