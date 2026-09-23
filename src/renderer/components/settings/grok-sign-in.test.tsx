// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GrokSignIn } from './grok-sign-in'
const state = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: state.fetch }))
afterEach(() => { cleanup(); vi.useRealTimers(); state.fetch.mockReset() })
it('shows the login link and code, then reports account identity without receiving tokens', async () => {
  state.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'flow', url: 'https://accounts.x.ai/oauth2/device?user_code=TEST', code: 'TEST', interval: 0.01 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'connected', accountLabel: 'member@example.test' })))
  const connected = vi.fn()
  render(<GrokSignIn userId={null} onConnected={connected} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Grok' }))
  expect(await screen.findByText('TEST')).toBeTruthy()
  expect(screen.getByRole('link').getAttribute('href')).toContain('accounts.x.ai')
  await waitFor(() => expect(connected).toHaveBeenCalledWith('flow', 'member@example.test'))
  expect(screen.queryByText('Waiting for sign-in…')).toBeNull()
})
it('shows an expired login error and permits a fresh login', async () => {
  state.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'flow', url: 'https://accounts.x.ai', code: 'TEST', interval: 0.01 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Sign-in expired. Start again.' }), { status: 400 }))
  render(<GrokSignIn userId={null} onConnected={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Grok' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in expired')
  expect(screen.getByRole('button', { name: 'Sign in with Grok' })).not.toBeDisabled()
})
it('cancels polling on unmount', async () => {
  vi.useFakeTimers()
  state.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'flow', url: 'https://accounts.x.ai', code: 'TEST', interval: 5 })))
  const view = render(<GrokSignIn userId={null} onConnected={vi.fn()} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in with Grok' })) })
  view.unmount()
  await act(async () => { vi.advanceTimersByTime(10_000) })
  expect(state.fetch).toHaveBeenCalledTimes(1)
})
