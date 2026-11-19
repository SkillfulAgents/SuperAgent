import { describe, it, expect, vi, beforeEach } from 'vitest'

const notifyAgentIdentityChanged = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../host-events', () => ({ notifyAgentIdentityChanged }))

import { AgentIdentityFileHook, identityOf } from './agent-identity-hook'
import { fileHooks } from './index'

const hook = new AgentIdentityFileHook()
const AGENTS = '/workspace/AGENTS.md'

function doc(frontmatter: string, body = 'Body') {
  return `---\n${frontmatter}\n---\n${body}\n`
}

const CURRENT = doc('name: Inbox Bot\ndescription: Triages Gmail.')

describe('identityOf', () => {
  it('reads name and description the way the host does', () => {
    expect(identityOf(doc('name: "Inbox Bot"\ndescription: Triages: Gmail\ncreatedAt: 2026-10-01'))).toEqual({
      name: 'Inbox Bot',
      description: 'Triages: Gmail',
    })
  })

  it('treats a missing document, missing frontmatter and blank values as absent', () => {
    expect(identityOf(null)).toEqual({})
    expect(identityOf('Just a body')).toEqual({})
    expect(identityOf(doc('name: "  "\ndescription:'))).toEqual({})
  })
})

describe('AgentIdentityFileHook', () => {
  beforeEach(() => {
    notifyAgentIdentityChanged.mockClear()
  })

  it('matches the instructions file only', () => {
    expect(hook.matches(AGENTS)).toBe(true)
    expect(hook.matches('/workspace/CLAUDE.md')).toBe(true)
    expect(hook.matches('/workspace/notes/AGENTS.md')).toBe(false)
    expect(hook.matches('/workspace/.claude/skills/send-report/SKILL.md')).toBe(false)
  })

  it('tells the host when the change edits the name or description, and says nothing', () => {
    expect(hook.onChange(AGENTS, CURRENT, doc('name: Inbox Bot\ndescription: Triages Gmail and drafts replies.'))).toEqual({})
    expect(hook.onChange(AGENTS, CURRENT, doc('name: Mail Helper\ndescription: Triages Gmail.'))).toEqual({})
    expect(notifyAgentIdentityChanged).toHaveBeenCalledTimes(2)
  })

  it('stays quiet on a body edit that leaves the identity alone', () => {
    expect(hook.onChange(AGENTS, CURRENT, doc('name: Inbox Bot\ndescription: Triages Gmail.', 'Always cc my boss.'))).toEqual({})
    expect(notifyAgentIdentityChanged).not.toHaveBeenCalled()
  })

  it('does not count a removed field as a change', () => {
    hook.onChange(AGENTS, CURRENT, doc('name: Inbox Bot'))
    expect(notifyAgentIdentityChanged).not.toHaveBeenCalled()
  })

  it('says when the file has no description', () => {
    const result = hook.onChange(AGENTS, doc('name: Inbox Bot'), doc('name: Inbox Bot', 'Always cc my boss.'))
    expect(result.warning).toContain('no "description" field')
    expect(notifyAgentIdentityChanged).not.toHaveBeenCalled()
  })

  it('says when the name is still the placeholder', () => {
    const before = doc('name: Untitled\ndescription: Triages Gmail.')
    const result = hook.onChange(AGENTS, before, doc('name: Untitled\ndescription: Triages Gmail.', 'Always cc my boss.'))
    expect(result.warning).toBe('The "name" field is still the placeholder "Untitled".')
  })

  it('says when the host will not take a value, and does not tell it about that field', () => {
    const tooLong = hook.onChange(AGENTS, CURRENT, doc(`name: Inbox Bot\ndescription: ${'x'.repeat(201)}`))
    expect(tooLong.warning).toContain('keeps the agent\'s current description')
    expect(tooLong.warning).toContain('at most 200')

    const block = hook.onChange(AGENTS, CURRENT, doc('name: Inbox Bot\ndescription: >-\n  Triages Gmail.'))
    expect(block.warning).toContain('YAML block value')

    expect(notifyAgentIdentityChanged).not.toHaveBeenCalled()
  })

  it('still tells the host about the valid field when the other is rejected', () => {
    const result = hook.onChange(AGENTS, CURRENT, doc(`name: Mail Helper\ndescription: ${'x'.repeat(201)}`))
    expect(result.warning).toContain('current description')
    expect(notifyAgentIdentityChanged).toHaveBeenCalledTimes(1)
  })

  it('is registered', () => {
    expect(fileHooks.some((h) => h instanceof AgentIdentityFileHook)).toBe(true)
  })
})
