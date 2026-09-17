import { describe, it, expect } from 'vitest'
import { buildAutomatedSessionPrompt } from './automated-session-prompt'

describe('buildAutomatedSessionPrompt', () => {
  it('names the trigger kind and states the session is unattended', () => {
    expect(buildAutomatedSessionPrompt('scheduled')).toMatch(/^This session was started automatically by a scheduled task\. Nobody is watching/)
    expect(buildAutomatedSessionPrompt('webhook')).toMatch(/^This session was started automatically by a webhook trigger\./)
  })

  it('bounds recovery: classify first, Retry-After, capped retries, resume only for long waits', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('Permission denied')
    expect(prompt).toContain('not transient')
    expect(prompt).toContain('Retry-After')
    expect(prompt).toContain('3 attempts')
    expect(prompt).toContain('mcp__user-input__schedule_resume')
    expect(prompt).toContain('Never chain resumes')
    expect(prompt).toContain('deadline')
    expect(prompt).toContain('next scheduled run or incoming event')
  })

  it('separates failed writes from unknown outcomes', () => {
    const prompt = buildAutomatedSessionPrompt('webhook')
    expect(prompt).toContain('Failed is not the same as unknown')
    expect(prompt).toContain('verify first')
    expect(prompt).toContain('Do not replay the action')
  })

  it('reports by outcome and routes input requests to the existing tools', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('"nothing changed", stay quiet')
    expect(prompt).toContain('what was done, what is missing')
    expect(prompt).toContain('designated chat channel, do not also raise a notification')
    expect(prompt).toContain('mcp__user-input__request_secret')
    expect(prompt).toContain('mcp__user-input__request_connected_account')
    expect(prompt).toContain('AskUserQuestion')
    expect(prompt).toContain('Once a user replies in this session, it is interactive')
  })
})
