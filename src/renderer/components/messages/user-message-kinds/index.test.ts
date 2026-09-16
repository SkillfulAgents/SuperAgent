import { describe, expect, it } from 'vitest'
import { classifyUserMessage, classifyUserText, plainMessage, USER_MESSAGE_KINDS } from './index'
import { buildConnectionReplacementMessage } from '@shared/lib/utils/connection-replacement-message'
import { SlashCommandBubble } from './slash-command'

const kindOf = (text: string) => classifyUserText(text).kind

describe('classifyUserText', () => {
  it('classifies a system prefix as hidden', () => {
    const spec = classifyUserText('[SYSTEM] Hidden setup message')
    expect(spec.kind).toBe('system')
    expect(spec.hidden).toBe(true)
    expect(spec.Render).toBeUndefined()
  })

  it('classifies an interrupt marker as a visible bare chip', () => {
    const spec = classifyUserText('[Request interrupted by user]')
    expect(spec.kind).toBe('interrupt')
    expect(spec.hidden).toBe(false)
    expect(spec.Render).toBeDefined()
    expect(spec.chrome).toBe('bare')
    expect(kindOf('[Request interrupted by user for tool use]')).toBe('interrupt')
  })

  it('classifies /compact at the start of trimmed text', () => {
    expect(kindOf('/compact')).toBe('compact')
    expect(kindOf('  /compact  ')).toBe('compact')
    expect(kindOf('/compact now')).toBe('compact')
  })

  it('does not treat /compaction as compact, but still as a slash command', () => {
    expect(kindOf('/compaction')).toBe('slash')
  })

  it('classifies other leading-slash text as a slash command with a custom bubble', () => {
    const spec = classifyUserText('/deploy production')
    expect(spec.kind).toBe('slash')
    expect(spec.hidden).toBe(false)
    expect(spec.Render).toBe(SlashCommandBubble)
    expect(classifyUserText('/compact').Render).toBe(SlashCommandBubble)
  })

  it('falls back to the shared plain spec', () => {
    expect(classifyUserText('hello')).toBe(plainMessage)
    expect(classifyUserText('')).toBe(plainMessage)
    expect(plainMessage.hidden).toBe(false)
    expect(plainMessage.Render).toBeUndefined()
  })

  it('does not trim before the system, interrupt, or slash prefixes', () => {
    expect(kindOf(' [SYSTEM] x')).toBe('plain')
    expect(kindOf('[SYSTEM]x')).toBe('plain')
    expect(kindOf(' [Request interrupted by user]')).toBe('plain')
    expect(kindOf(' /deploy')).toBe('plain')
  })

  it('returns the same spec object on every call', () => {
    expect(classifyUserText('[SYSTEM] a')).toBe(classifyUserText('[SYSTEM] b'))
  })

  it('classifies the voice-mode notices as a visible row boundary, ahead of the hidden system prefix', () => {
    const entered = classifyUserText('[SYSTEM] The user switched to voice mode.\nKeep replies brief.')
    expect(entered.kind).toBe('voice-mode')
    expect(entered.hidden).toBe(false)
    expect(entered.chrome).toBe('row')
    expect(classifyUserText('[SYSTEM] The user left voice mode.').kind).toBe('voice-mode')
    // Any other system message stays hidden.
    expect(classifyUserText('[SYSTEM] The user switched to something else.').kind).toBe('system')
  })

  it.each(['connected-accounts', 'remote-mcps'] as const)('shows %s replacement notices before the hidden system catch-all', (kind) => {
    const text = buildConnectionReplacementMessage({ kind, name: 'Service', previousId: 'old', replacementId: 'new' })
    const spec = classifyUserText(text)
    expect(spec.kind).toBe('connection-replacement')
    expect(spec.hidden).toBe(false)
    expect(spec.chrome).toBe('row')
    expect(classifyUserText('[SYSTEM] Connection to an unrelated service').hidden).toBe(true)
  })

  it('lists hidden kinds before the other visible ones so the visibility filter is order-safe', () => {
    // Dedicated system notices must precede the hidden system prefix.
    const notices = ['voice-mode', 'connection-replacement']
    const rest = USER_MESSAGE_KINDS.filter((spec) => !notices.includes(spec.kind))
    const firstVisible = rest.findIndex((spec) => !spec.hidden)
    expect(rest.slice(firstVisible).every((spec) => !spec.hidden)).toBe(true)
    for (const kind of notices) {
      expect(USER_MESSAGE_KINDS.findIndex((spec) => spec.kind === kind)).toBeLessThan(
        USER_MESSAGE_KINDS.findIndex((spec) => spec.kind === 'system'),
      )
    }
  })
})

describe('classifyUserMessage', () => {
  it('classifies a user message from its text', () => {
    expect(classifyUserMessage({
      type: 'user',
      content: { text: '[SYSTEM] Hidden setup message' },
    }).kind).toBe('system')
  })

  it('returns plain for a non-user message', () => {
    expect(classifyUserMessage({
      type: 'assistant',
      content: { text: '[SYSTEM] Hidden setup message' },
    })).toBe(plainMessage)
  })

  it('returns plain when content is a string', () => {
    expect(classifyUserMessage({
      type: 'user',
      content: '[Request interrupted by user]',
    })).toBe(plainMessage)
  })

  it('returns plain for missing, null, or empty-object content', () => {
    expect(classifyUserMessage({ type: 'user' })).toBe(plainMessage)
    expect(classifyUserMessage({ type: 'user', content: null })).toBe(plainMessage)
    expect(classifyUserMessage({ type: 'user', content: {} })).toBe(plainMessage)
  })
})
