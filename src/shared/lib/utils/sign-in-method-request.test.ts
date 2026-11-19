import { describe, expect, it } from 'vitest'
import { buildSignInMethodRequestMessage, parseSignInMethodRequestMessage } from './sign-in-method-request'

describe('sign-in method request messages', () => {
  it('reads back what it was built from, whoever the account is', () => {
    for (const note of [
      { username: 'octocat', site: 'github.com', from: 'card' as const },
      { username: 'ada on the team@example.com', site: 'accounts.google.com', from: 'logins' as const },
    ]) {
      expect(parseSignInMethodRequestMessage(buildSignInMethodRequestMessage(note))).toEqual(note)
    }
    // A bracket or a line break in a name cannot end the note early.
    expect(parseSignInMethodRequestMessage(buildSignInMethodRequestMessage({ username: 'a] b\nc', site: 'x.com', from: 'card' })))
      .toEqual({ username: 'a  b c', site: 'x.com', from: 'card' })
  })

  it('marks a request sent again', () => {
    const again = buildSignInMethodRequestMessage({ username: 'octocat', site: 'github.com', from: 'card', again: true })
    expect(again).toMatch(/\n\n\[Sent again from the sign-in form for octocat on github\.com\]$/)
    expect(parseSignInMethodRequestMessage(again)).toEqual({ username: 'octocat', site: 'github.com', from: 'card', again: true })
  })

  it('ends with a note in words, not data', () => {
    expect(buildSignInMethodRequestMessage({ username: 'octocat', site: 'github.com', from: 'card' })).toMatch(/\n\n\[Sent from the sign-in form for octocat on github\.com\]$/)
  })

  it('says where the user asked, in their own words', () => {
    expect(buildSignInMethodRequestMessage({ username: 'octocat', site: 'github.com', from: 'logins' }))
      .toMatch(/^From Settings → Logins: once you are signed in, also add an authenticator app to my account octocat on github\.com with add_sign_in_method,/)
  })

  it('reads no request from any other message', () => {
    expect(parseSignInMethodRequestMessage('Please add an authenticator app to my GitHub')).toBeNull()
    expect(parseSignInMethodRequestMessage('Hi\n\n[Sent from my phone]')).toBeNull()
    expect(parseSignInMethodRequestMessage('Hi\n\n[Sent from the sign-in form for x on y] and more')).toBeNull()
  })
})
