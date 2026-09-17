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
  })

  it('states three stop conditions for a resume and does not assume a follow-up webhook', () => {
    const prompt = buildAutomatedSessionPrompt('webhook')
    expect(prompt).toContain('Do not schedule a resume if any of these holds')
    expect(prompt).toContain('pass a deadline the user gave')
    expect(prompt).toContain('lost its value')
    expect(prompt).toContain('confirmed the next scheduled run covers the same work')
    expect(prompt).toContain('Do not assume another webhook event will arrive')
  })

  it('lets a resume continue the same recovery budget instead of forbidding chained wakes', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).not.toContain('Never chain resumes')
    expect(prompt).toContain('continues this recovery, it does not restart it')
    expect(prompt).toContain('attempts made so far, the failure reason, and any deadline in the resume note')
    expect(prompt).toContain('same error persists after the resume, stop and escalate')
  })

  it('separates failed writes from unknown outcomes', () => {
    const prompt = buildAutomatedSessionPrompt('webhook')
    expect(prompt).toContain('Failed is not the same as unknown')
    expect(prompt).toContain('verify first')
    expect(prompt).toContain('Do not replay the action')
  })

  it('lets the task agreement decide whether a no-change run is reported', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain("The task's agreement decides whether a \"nothing changed\" run is reported")
    expect(prompt).toContain('if it asks for a report every run, send one')
    expect(prompt).toContain('Only when the task allows silence and there is nothing worth reporting')
    expect(prompt).not.toContain('stay quiet')
  })

  it('escalates by outcome and routes input requests to the existing tools', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('what was done, what is missing')
    expect(prompt).toContain('designated chat channel, do not also raise a notification')
    expect(prompt).toContain('mcp__user-input__request_secret')
    expect(prompt).toContain('mcp__user-input__request_connected_account')
    expect(prompt).toContain('AskUserQuestion')
  })

  it('does not turn a question tool into a notification substitute', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('Ask only real questions; do not use them to announce an outcome')
    expect(prompt).not.toContain('Acknowledged')
  })

  it('switches to interactive only on a human reply and keeps the safety rules and spent budget', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('If a human replies in this session (a scheduled wake-up message is not a human)')
    expect(prompt).toContain('stop assuming nobody is watching')
    expect(prompt).toContain('error-handling and verification rules below still apply')
    expect(prompt).toContain('retry budget you have already spent stays spent')
    expect(prompt).not.toContain('drop these assumptions')
  })

  it('routes the no-question, no-channel case to notify_user, once, while hidden', () => {
    const prompt = buildAutomatedSessionPrompt('scheduled')
    expect(prompt).toContain('call `mcp__user-input__notify_user` once')
    expect(prompt).toContain('only works while this session is still hidden')
  })
})
