// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { LoginRequestItem } from './request'
import { resetLoginRequestStore } from './login-request-store'
import type { LoginContext } from './login-request'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const mockToast = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: mockToast }))

const electron = vi.hoisted(() => ({ value: false }))
vi.mock('@renderer/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/env')>()),
  isElectron: () => electron.value,
}))

// The picker has focused tests of its own; here only where it is offered and
// what a fill through it does to the request.
const pickerAnswer = vi.hoisted(() => ({ body: null as unknown }))
vi.mock('../request-browser-input/browser-credential-picker', () => ({
  BrowserCredentialPicker: (props: { kind?: string; onFilled?: (body: unknown) => void }) => (
    <button
      data-testid="credential-picker"
      data-kind={props.kind}
      onClick={() => props.onFilled?.(pickerAnswer.body)}
    >
      saved login
    </button>
  ),
}))

const BASE = '/api/agents/my-agent/sessions/s-1'
const CONTEXT: LoginContext = {
  origin: 'https://github.com',
  url: 'https://github.com/login',
  topOrigin: 'https://github.com',
  submit: true,
  fields: [
    { kind: 'username', label: 'Username or email address', inputType: 'email', inputMode: '', autocomplete: 'username', maxLength: -1 },
    { kind: 'password', label: 'Password', inputType: 'password', inputMode: '', autocomplete: 'current-password', maxLength: -1 },
    { kind: 'otp', label: 'Authentication code', inputType: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 1 },
  ],
}

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) })

type Route = (init?: RequestInit) => ReturnType<typeof json> | Promise<ReturnType<typeof json>>
let routes: Record<string, Route>

function props(extra: Partial<Parameters<typeof LoginRequestItem>[0]> = {}) {
  return {
    toolUseId: 'tu-1',
    // The agent's words: never the title, and never trusted for the site.
    message: 'Sign in to totally-not-github.example so the agent can read settings.',
    fields: [
      { kind: 'username' as const, label: 'Username or email address' },
      { kind: 'password' as const, label: 'Password' },
      { kind: 'otp' as const, label: 'Authentication code' },
    ],
    sessionId: 's-1',
    agentSlug: 'my-agent',
    onComplete: vi.fn(),
    ...extra,
  }
}

function posted(path: string): Record<string, unknown>[] {
  return mockApiFetch.mock.calls
    .filter(([url, init]) => url === `${BASE}${path}` && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
}

function contextIs(context: Partial<LoginContext> | Route) {
  routes[`${BASE}/login-request?toolUseId=tu-1`] = typeof context === 'function' ? context : () => json(200, { ...CONTEXT, ...context })
}

async function ready() {
  const first = await screen.findByTestId('login-field-0')
  await waitFor(() => expect(first).not.toBeDisabled())
  return first
}

describe('LoginRequestItem', () => {
  beforeEach(() => {
    resetLoginRequestStore()
    mockApiFetch.mockReset()
    mockToast.warning.mockReset()
    electron.value = false
    pickerAnswer.body = { success: true, filled: 2, failed: 0, submitted: true, problems: [] }
    routes = {
      [`${BASE}/login-request?toolUseId=tu-1`]: () => json(200, CONTEXT),
      [`${BASE}/fill-login`]: () => json(200, { success: true, filled: 3, failed: 0, submitted: true, problems: [] }),
      [`${BASE}/complete-login`]: () => json(200, { success: true }),
      [`${BASE}/messages`]: () => json(200, {}),
    }
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      const route = routes[url]
      return Promise.resolve(route ? route(init) : json(404, { error: `unrouted ${url}` }))
    })
  })

  it('titles the card with the site the browser reported, not the agent\'s words', async () => {
    render(<LoginRequestItem {...props()} />)
    expect(await screen.findByText('Sign in to github.com')).toBeInTheDocument()
    expect(screen.getByTestId('login-origin')).toHaveTextContent('https://github.com')
    expect(screen.getByText(/totally-not-github\.example/)).toBeInTheDocument()
  })

  it('says exactly what the agent can see: the username, never the password or code', async () => {
    render(<LoginRequestItem {...props()} />)
    await ready()
    expect(screen.getByTestId('login-privacy')).toHaveTextContent(
      'What you enter goes straight into github.com. The agent never sees the password or code; it can see the username.',
    )
  })

  it('shows each field\'s kind in the app\'s words beside the page\'s label', async () => {
    contextIs({ fields: [...CONTEXT.fields, { kind: 'text', label: 'Password', inputType: 'text', inputMode: '', autocomplete: '', maxLength: -1 }] })
    render(<LoginRequestItem {...props({ fields: [...props().fields, { kind: 'text', label: 'Password' }] })} />)
    await ready()
    expect(screen.getByTestId('login-field-kind-0')).toHaveTextContent('username')
    expect(screen.getByTestId('login-field-kind-1')).toHaveTextContent('password')
    expect(screen.getByTestId('login-field-kind-2')).toHaveTextContent('code')
    // A label the agent chose cannot pass for another kind.
    expect(screen.getByTestId('login-field-kind-3')).toHaveTextContent('other')
  })

  it('notes a form in a frame of another site, and plain-HTTP sites', async () => {
    contextIs({ origin: 'http://login.example.net', topOrigin: 'https://shop.example.com' })
    render(<LoginRequestItem {...props()} />)
    expect(await screen.findByTestId('login-framed')).toHaveTextContent('In a frame on shop.example.com')
    expect(screen.getByTestId('login-insecure')).toHaveTextContent('Not encrypted (http)')
  })

  it('draws the agent\'s fields disabled until the browser has located them', async () => {
    let release!: () => void
    contextIs(() => new Promise((resolve) => { release = () => resolve(json(200, CONTEXT)) }))
    render(<LoginRequestItem {...props()} />)
    expect(await screen.findByText('Locating the sign-in form on the page…')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeDisabled()
    expect(screen.getByTestId('login-submit')).toBeDisabled()
    release()
    await waitFor(() => expect(screen.getByLabelText('Password')).not.toBeDisabled())
    // Focused once usable, not on mount.
    expect(screen.getByTestId('login-field-0')).toHaveFocus()
  })

  it('tries again while the browser is still locating the fields', async () => {
    let calls = 0
    contextIs(() => (++calls === 1 ? json(404, { error: 'The sign-in form is still being located' }) : json(200, CONTEXT)))
    render(<LoginRequestItem {...props()} />)
    await waitFor(() => expect(screen.getByTestId('login-field-0')).not.toBeDisabled(), { timeout: 3000 })
    expect(calls).toBe(2)
    expect(screen.queryByTestId('login-unavailable')).not.toBeInTheDocument()
  })

  it('keeps every value out of password managers, with masked text instead of password inputs', async () => {
    render(<LoginRequestItem {...props()} />)
    const username = await ready()
    expect(username).toHaveAttribute('type', 'text')
    expect(username).toHaveAttribute('inputmode', 'email')
    expect(username).toHaveAttribute('autocomplete', 'off')
    expect(username).toHaveAttribute('data-1p-ignore', 'true')
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'text')
    expect(password.className).toContain('[-webkit-text-security:disc]')
    expect(password).toHaveAttribute('autocomplete', 'off')
    expect(password).toHaveAttribute('data-lpignore', 'true')
    // The one hint kept: the OS offers a code from an SMS.
    const code = screen.getByLabelText('Authentication code')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
    expect(code).toHaveAttribute('inputmode', 'numeric')
    // A code split across one-character boxes on the page is typed whole here.
    expect(code).not.toHaveAttribute('maxlength')
    // No native validation: an "email or phone" field takes a phone number.
    expect(screen.getByTestId('login-form')).toHaveAttribute('novalidate')
  })

  it('uses real password inputs in the desktop app, which has no password manager, with a labelled toggle', async () => {
    electron.value = true
    const user = userEvent.setup()
    render(<LoginRequestItem {...props()} />)
    await ready()
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    expect(password.className).not.toContain('[-webkit-text-security:disc]')
    const toggle = screen.getByRole('button', { name: 'Show Password' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(password).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('takes focus once the fields are ready — unless the user is typing somewhere else', async () => {
    const user = userEvent.setup()
    let release!: () => void
    contextIs(() => new Promise((resolve) => { release = () => resolve(json(200, CONTEXT)) }))
    render(<><input aria-label="Composer" /><LoginRequestItem {...props()} /></>)
    await user.click(screen.getByLabelText('Composer'))
    await user.keyboard('half a sente')
    release()
    await ready()
    expect(screen.getByLabelText('Composer')).toHaveFocus()
  })

  it('moves focus to the first field when nothing else has it', async () => {
    render(<LoginRequestItem {...props()} />)
    const first = await ready()
    await waitFor(() => expect(first).toHaveFocus())
  })

  it('ties an error to the fields it is about', async () => {
    const user = userEvent.setup()
    routes[`${BASE}/fill-login`] = () => json(502, { error: 'The browser is unavailable' })
    render(<LoginRequestItem {...props()} />)
    await ready()
    await user.type(screen.getByLabelText('Username or email address'), 'octocat')
    await user.type(screen.getByLabelText('Password'), 'pw-1')
    await user.type(screen.getByLabelText('Authentication code'), '123456')
    await user.click(screen.getByTestId('login-submit'))
    const error = await screen.findByTestId('login-error')
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', error.id)
  })

  it('sends one value per field to the site the form showed, then resolves', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<LoginRequestItem {...props({ onComplete })} />)
    const username = await ready()
    expect(screen.getByTestId('login-submit')).toBeDisabled()

    await user.type(username, '+1 555 0100')
    await user.type(screen.getByLabelText('Password'), 'hunter2-hunter2')
    await user.type(screen.getByLabelText('Authentication code'), '482913')
    await user.click(screen.getByTestId('login-submit'))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(posted('/fill-login')).toEqual([{
      toolUseId: 'tu-1',
      origin: 'https://github.com',
      values: ['+1 555 0100', 'hunter2-hunter2', '482913'],
    }])
    expect(screen.getByTestId('login-request-completed')).toHaveAttribute('data-status', 'filled')
    expect(mockToast.warning).not.toHaveBeenCalled()
  })

  it('says so where it outlives the card when nothing went into the page', async () => {
    const user = userEvent.setup()
    routes[`${BASE}/fill-login`] = () => json(200, { success: true, filled: 0, failed: 2, submitted: false, problems: ['Password: @e6 is not visible'] })
    contextIs({ fields: CONTEXT.fields.slice(0, 2) })
    render(<LoginRequestItem {...props({ fields: props().fields.slice(0, 2) })} />)
    const username = await ready()
    await user.type(username, 'octocat')
    await user.type(screen.getByLabelText('Password'), 'hunter2-hunter2')
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith('Nothing was filled on the page', { description: 'Password: @e6 is not visible' }))
  })

  it('submits from the keyboard with Enter, never declining', async () => {
    const user = userEvent.setup()
    contextIs({ fields: [CONTEXT.fields[0]] })
    render(<LoginRequestItem {...props({ fields: [{ kind: 'username', label: 'Username or email address' }] })} />)
    const username = await ready()
    expect(screen.getByTestId('login-submit')).toHaveTextContent('Continue')
    await user.type(username, 'octocat@example.com{Enter}')
    await waitFor(() => expect(posted('/fill-login')).toHaveLength(1))
    // Enter submits the form; it must never press Decline, which sits beside it.
    expect(posted('/complete-login')).toEqual([])
  })

  it('keeps the form open with the error when the fill fails, and lets the user retry', async () => {
    const user = userEvent.setup()
    routes[`${BASE}/fill-login`] = () => json(502, { error: 'The browser is unavailable' })
    contextIs({ fields: [CONTEXT.fields[1]] })
    const onComplete = vi.fn()
    render(<LoginRequestItem {...props({ onComplete, fields: [{ kind: 'password', label: 'Password' }] })} />)
    const password = await ready()
    await user.type(password, 'hunter2-hunter2')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('The browser is unavailable')
    expect(onComplete).not.toHaveBeenCalled()
    expect(password).toHaveValue('hunter2-hunter2')

    routes[`${BASE}/fill-login`] = () => json(200, { success: true, filled: 1, failed: 0, submitted: true, problems: [] })
    await user.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
  })

  it('says why the form cannot be used when the browser could not use the agent\'s fields', async () => {
    contextIs(() => json(409, {
      error: 'The browser could not locate the sign-in fields',
      problems: ['@e6 is <input type=email>; a password goes into a password input'],
    }))
    render(<LoginRequestItem {...props()} />)
    expect(await screen.findByTestId('login-unavailable')).toHaveTextContent('@e6 is <input type=email>')
    expect(screen.getByTestId('login-submit')).toBeDisabled()
    expect(screen.getByTestId('login-take-over')).not.toBeDisabled()
  })

  it('offers no way in, not even by hand, when the fields are on this app\'s own page', async () => {
    contextIs(() => json(409, {
      error: 'This sign-in form is for this app itself',
      reason: 'this_app',
      problems: ['The fields are on http://host.docker.internal:47891, this app\'s own address: the agent\'s browser is not signed in to it.'],
    }))
    render(<LoginRequestItem {...props()} />)
    expect(await screen.findByTestId('login-unavailable')).toHaveTextContent('this app\'s own address')
    expect(screen.queryByTestId('login-take-over')).toBeNull()
    expect(screen.getByTestId('login-submit')).toBeDisabled()
    expect(screen.getByTestId('login-decline')).not.toBeDisabled()
  })

  it('lets the user sign in on the page instead, then tells the agent they are done', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<LoginRequestItem {...props({ onComplete })} />)
    await screen.findByText('Sign in to github.com')
    await user.click(screen.getByTestId('login-take-over'))
    expect(screen.getByTestId('login-manual')).toHaveTextContent('Sign in directly in the browser view on github.com')
    expect(screen.getByTestId('login-manual')).toHaveTextContent('not hidden from the agent')
    await user.click(screen.getByTestId('login-manual-done'))
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(posted('/complete-login')).toEqual([{ toolUseId: 'tu-1', action: 'manual' }])
    expect(posted('/fill-login')).toEqual([])
  })

  it('declines, and sends the reason given to the agent as a message', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<LoginRequestItem {...props({ onComplete })} />)
    await screen.findByText('Sign in to github.com')
    await user.click(screen.getByTestId('login-decline-chevron'))
    await user.type(await screen.findByPlaceholderText('Reason for declining...'), 'Use my work account instead{Enter}')
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(posted('/complete-login')).toEqual([{ toolUseId: 'tu-1', action: 'decline' }])
    expect(posted('/messages')).toEqual([{ content: 'Use my work account instead' }])
    expect(screen.getByTestId('login-request-completed')).toHaveAttribute('data-status', 'declined')
  })

  it('shows an answer given elsewhere as already answered', async () => {
    const user = userEvent.setup()
    routes[`${BASE}/complete-login`] = () => json(200, { success: true, alreadySettled: true })
    const onComplete = vi.fn()
    render(<LoginRequestItem {...props({ onComplete })} />)
    await screen.findByText('Sign in to github.com')
    await user.click(screen.getByTestId('login-take-over'))
    await user.click(screen.getByTestId('login-manual-done'))
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(screen.getByTestId('login-request-completed')).toHaveAttribute('data-status', 'settled')
  })

  it('offers a saved login only when the page asks for nothing else, and settles the request when one is filled', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    contextIs({ fields: CONTEXT.fields.slice(0, 2) })
    render(<LoginRequestItem {...props({ onComplete, fields: props().fields.slice(0, 2) })} />)
    const picker = await screen.findByTestId('credential-picker')
    expect(picker).toHaveAttribute('data-kind', 'login')
    await user.click(picker)
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(posted('/fill-login')).toEqual([])
  })

  it('shows a saved login sent after the request was answered elsewhere as already answered, not as a failed fill', async () => {
    const user = userEvent.setup()
    pickerAnswer.body = { success: true, alreadySettled: true }
    const onComplete = vi.fn()
    contextIs({ fields: CONTEXT.fields.slice(0, 2) })
    render(<LoginRequestItem {...props({ onComplete, fields: props().fields.slice(0, 2) })} />)
    await user.click(await screen.findByTestId('credential-picker'))
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
    expect(screen.getByTestId('login-request-completed')).toHaveAttribute('data-status', 'settled')
    expect(mockToast.warning).not.toHaveBeenCalled()
  })

  it('offers no saved login when the page also asks for a code', async () => {
    render(<LoginRequestItem {...props()} />)
    await ready()
    expect(screen.queryByTestId('credential-picker')).not.toBeInTheDocument()
  })

  it('shows no form to read-only viewers, and reads nothing for them', async () => {
    render(<LoginRequestItem {...props({ readOnly: true })} />)
    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument()
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
