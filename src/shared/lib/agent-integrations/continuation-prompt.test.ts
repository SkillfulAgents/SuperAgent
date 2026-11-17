import { describe, expect, it } from 'vitest'
import { continuationPrompt } from './continuation-prompt'

describe('continuationPrompt', () => {
  it('names the earlier session and says how to read it', () => {
    const prompt = continuationPrompt('old-session')

    expect(prompt).toContain('continues an earlier session with the same person: old-session.')
    expect(prompt).toContain('`uv run /opt/gamut/bin/read-session.py old-session`')
    expect(prompt).toContain('list-sessions.py')
  })
})
