/**
 * Regression: late-join replay must carry the latest background_tasks_changed
 * snapshot. Without it, a host holding a task whose terminal signal was lost
 * parks in waiting-background after reattach announces "turn over".
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeProcess } from './claude-code'
import { parseBackgroundTasksChanged } from './session-settlement'

const backgroundTasksFrameSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('background_tasks_changed'),
    tasks: z.array(
      z.object({
        task_id: z.string(),
        task_type: z.string().optional(),
        description: z.string().optional(),
      })
    ),
  })
  .superRefine((frame, ctx) => {
    if (!parseBackgroundTasksChanged(frame)) {
      ctx.addIssue({ code: 'custom', message: 'rejected by parseBackgroundTasksChanged' })
    }
  })

const resultFrameSchema = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
})

const sessionStateFrameSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('session_state_changed'),
  state: z.enum(['idle', 'running']),
})

describe('getLateJoinReplay — background snapshot', () => {
  it('includes the latest background_tasks_changed between result and idle', () => {
    const proc = new ClaudeCodeProcess({
      sessionId: 'late-join-bg',
      workingDirectory: '/tmp',
    })

    const track = (frame: unknown) =>
      (proc as unknown as { trackForLateJoinReplay(message: unknown): void }).trackForLateJoinReplay(
        frame
      )

    track(resultFrameSchema.parse({ type: 'result', subtype: 'success' }))
    track(
      backgroundTasksFrameSchema.parse({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      })
    )
    track(
      sessionStateFrameSchema.parse({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      })
    )

    const replay = proc.getLateJoinReplay() as Array<Record<string, unknown>>
    const subtypes = replay.map((f) => f.subtype ?? f.type)

    expect(subtypes).toContain('background_tasks_changed')
    const bgIndex = replay.findIndex((f) => f.subtype === 'background_tasks_changed')
    const resultIndex = replay.findIndex((f) => f.type === 'result')
    const idleIndex = replay.findIndex(
      (f) => f.subtype === 'session_state_changed' && f.state === 'idle'
    )
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(bgIndex).toBeGreaterThan(resultIndex)
    expect(idleIndex).toBeGreaterThan(bgIndex)
    expect(replay[bgIndex]).toMatchObject({
      subtype: 'background_tasks_changed',
      tasks: [],
      replayed: true,
    })
  })
})
