// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildSignInMethodRequestMessage } from '@shared/lib/utils/sign-in-method-request'
import { createUserMessage } from '@renderer/test/factories'
import { classifyUserText } from './index'
import { SignInMethodRequestNotice } from './sign-in-method-request'

it.each([
  ['card', 'Asked from the sign-in form'],
  ['logins', 'Asked from Settings → Logins'],
] as const)('draws a request from %s as a note of what the user did, not as their typed message', (from, title) => {
  const text = buildSignInMethodRequestMessage({ username: 'octocat', site: 'github.com', from })
  expect(classifyUserText(text).kind).toBe('sign-in-method-request')
  const renderMarkdown = vi.fn()
  render(<SignInMethodRequestNotice text={text} message={createUserMessage()} renderMarkdown={renderMarkdown} />)
  const notice = screen.getByTestId('sign-in-method-request-notice')
  expect(notice).toHaveTextContent(title)
  expect(notice).toHaveTextContent('Add a passkey or authenticator app to octocat on github.com.')
  // What the agent was told stays out of the note.
  expect(notice).not.toHaveTextContent('add_sign_in_method')
  expect(notice).not.toHaveTextContent('[Sent from')
  expect(renderMarkdown).not.toHaveBeenCalled()
})

it('draws the request sent again as a note of its own', () => {
  const text = buildSignInMethodRequestMessage({ username: 'octocat', site: 'github.com', from: 'card', again: true })
  expect(classifyUserText(text)).toMatchObject({ kind: 'sign-in-method-request', hidden: false })
  render(<SignInMethodRequestNotice text={text} message={createUserMessage()} renderMarkdown={vi.fn()} />)
  expect(screen.getByTestId('sign-in-method-request-notice')).toHaveTextContent('Asked again from the sign-in form')
})

describe('other messages', () => {
  it('stay plain, even when they mention the form', () => {
    expect(classifyUserText('From the sign-in form: add a passkey').kind).toBe('plain')
    render(<SignInMethodRequestNotice text="From the sign-in form: add a passkey" message={createUserMessage()} renderMarkdown={vi.fn()} />)
    expect(screen.queryByTestId('sign-in-method-request-notice')).not.toBeInTheDocument()
  })
})
