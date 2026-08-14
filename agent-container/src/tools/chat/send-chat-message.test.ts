/**
 * The description used to independently license automations to send.
 * That phrase must stay gone; delivery facts live in per-session orientation.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(__dirname, 'send-chat-message.ts'), 'utf-8')

describe('send_chat_message description', () => {
  it('does not independently license scheduled or background sends', () => {
    expect(source).not.toContain('scheduled or background run')
    expect(source).not.toContain('ONLY to initiate contact')
  })

  it('preserves explicit, cross-chat, and double-post guidance', () => {
    expect(source).toContain('when you were asked to')
    expect(source).toContain('a chat other than the one this session is already responding in')
    expect(source).toContain("It is not how you deliver this session's own response")
    expect(source).toContain('sending it here would post it twice')
  })
})
