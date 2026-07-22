import { describe, expect, it } from 'vitest'
import {
  ClassifierConfigSchema,
  CreateScheduledJobSchema,
  GatherSpecSchema,
  parseClassifierConfig,
  parseClassifierHandoff,
  parseExecutionMode,
  ScheduledJobRuntimeConfigSchema,
  validateClassifierConfig,
} from './classifier-config-schema'

describe('classifier-config-schema', () => {
  it('accepts a session job (today)', () => {
    const parsed = CreateScheduledJobSchema.parse({
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * 1-5',
      name: 'Daily standup',
      executionMode: 'session',
      prompt: 'Summarize overnight alerts.',
      model: 'opus',
      effort: 'high',
    })
    expect(parsed.executionMode).toBe('session')
  })

  it('accepts a classifier job with empty gather', () => {
    const parsed = CreateScheduledJobSchema.parse({
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      timezone: 'America/Los_Angeles',
      name: 'inbox-morning-triage',
      executionMode: 'classifier',
      prompt: 'Triage inbox items that need action and draft replies where appropriate.',
      classifier: {
        gather: { version: 1, sources: [] },
        criteria:
          'Escalate when any item needs human action (bills, asks, schedule confirms). Settle on newsletters/receipts/FYI only.',
        classifyModel: 'haiku',
        classifyEffort: 'low',
        escalateModel: 'opus',
        escalateEffort: 'high',
      },
    })
    expect(parsed.executionMode).toBe('classifier')
    if (parsed.executionMode !== 'classifier') throw new Error('unreachable')
    expect(parsed.prompt).toContain('Triage inbox')
    expect(parsed.classifier.gather.sources).toEqual([])
  })

  it('rejects classifier job missing job-brief prompt', () => {
    expect(() =>
      CreateScheduledJobSchema.parse({
        scheduleType: 'cron',
        scheduleExpression: '0 9 * * *',
        executionMode: 'classifier',
        classifier: {
          gather: { version: 1, sources: [] },
          criteria: 'Escalate on bills.',
          escalateModel: 'sonnet',
          escalateEffort: 'high',
        },
      }),
    ).toThrow()
  })

  it('defaults classify model/effort when omitted', () => {
    const cfg = ClassifierConfigSchema.parse({
      gather: { version: 1, sources: [] },
      criteria: 'Escalate on core degradation; settle when clean.',
      escalateModel: 'sonnet',
      escalateEffort: 'medium',
    })
    expect(cfg.classifyModel).toBe('haiku')
    expect(cfg.classifyEffort).toBe('low')
  })

  it('accepts empty/omitted gather but rejects any non-empty sources (PR1)', () => {
    // Empty and omitted both default to [].
    expect(GatherSpecSchema.parse({ version: 1, sources: [] }).sources).toEqual([])
    expect(GatherSpecSchema.parse({ version: 1 }).sources).toEqual([])
    // Non-empty sources are rejected until the gather runner ships.
    expect(() =>
      GatherSpecSchema.parse({
        version: 1,
        sources: [{ id: 'inbox', kind: 'inbox_window', windowHours: 24 }],
      }),
    ).toThrow()
  })

  it('rejects classifier config missing escalate model', () => {
    expect(() =>
      ScheduledJobRuntimeConfigSchema.parse({
        executionMode: 'classifier',
        prompt: 'Handle bills that need action.',
        classifier: {
          gather: { version: 1, sources: [] },
          criteria: 'Escalate on bills.',
          classifyModel: 'haiku',
          classifyEffort: 'low',
        },
      }),
    ).toThrow()
  })

  it('validate/parse classifier config at the DB boundary', () => {
    const cfg = validateClassifierConfig({
      gather: { version: 1, sources: [] },
      criteria: 'Escalate on bills.',
      escalateModel: 'opus',
      escalateEffort: 'high',
    })
    const json = JSON.stringify(cfg)
    expect(parseClassifierConfig(json)?.escalateModel).toBe('opus')
    expect(parseClassifierConfig('{')).toBeNull()
    expect(parseClassifierConfig(JSON.stringify({ criteria: 'x' }))).toBeNull()
  })

  it('parses a valid handoff and rejects malformed', () => {
    expect(parseClassifierHandoff({ verdict: 'settle', reason: 'all clear' })).toEqual({
      verdict: 'settle',
      reason: 'all clear',
    })
    expect(parseClassifierHandoff('{"verdict":"escalate","reason":"needs work"}')).toEqual({
      verdict: 'escalate',
      reason: 'needs work',
    })
    expect(parseClassifierHandoff({ verdict: 'settle' })).toBeNull()
    expect(parseClassifierHandoff('not-json')).toBeNull()
  })

  it('narrows execution mode at the fire read boundary', () => {
    expect(parseExecutionMode('session')).toBe('session')
    expect(parseExecutionMode('classifier')).toBe('classifier')
    expect(parseExecutionMode(null)).toBe('session')
    expect(parseExecutionMode('weird')).toBe('session')
  })
})
