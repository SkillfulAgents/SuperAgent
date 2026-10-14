import { describe, it, expect } from 'vitest'
import { AgentDescriptionHintFileHook, DESCRIPTION_HINT } from './agent-description-hint-hook'
import { fileHooks } from './index'

const hook = new AgentDescriptionHintFileHook()

describe('AgentDescriptionHintFileHook', () => {
  it('matches the instructions file and skill files', () => {
    expect(hook.matches('/workspace/AGENTS.md')).toBe(true)
    expect(hook.matches('/workspace/CLAUDE.md')).toBe(true)
    expect(hook.matches('/workspace/.claude/skills/send-report/SKILL.md')).toBe(true)
  })

  it('does not match other markdown files', () => {
    expect(hook.matches('/workspace/notes/AGENTS.md')).toBe(false)
    expect(hook.matches('/workspace/README.md')).toBe(false)
    expect(hook.matches('/workspace/.claude/skills/send-report/notes.md')).toBe(false)
  })

  it('hints on write and edit without blocking', () => {
    expect(hook.onWrite()).toEqual({ warning: DESCRIPTION_HINT })
    expect(hook.onEdit()).toEqual({ warning: DESCRIPTION_HINT })
  })

  it('is registered', () => {
    expect(fileHooks.some((h) => h instanceof AgentDescriptionHintFileHook)).toBe(true)
  })
})
