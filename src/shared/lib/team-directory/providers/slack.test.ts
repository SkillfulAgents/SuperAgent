import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryConnectError } from '../types'
import { slackDirectoryProvider } from './slack'

type SlackRoute = (form: URLSearchParams) => { status?: number; body?: unknown; headers?: Record<string, string> }

let routes: Record<string, SlackRoute>
let calls: Array<{ method: string; form: URLSearchParams; token: string | null }>

beforeEach(() => {
  calls = []
  routes = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = url.replace('https://slack.com/api/', '')
    const form = new URLSearchParams(init.body as URLSearchParams)
    calls.push({ method, form, token: new Headers(init.headers).get('authorization') })
    const route = routes[method]
    if (!route) return new Response(JSON.stringify({ ok: false, error: 'unknown_method' }))
    const { status = 200, body = {}, headers = {} } = route(form)
    return new Response(JSON.stringify(body), { status, headers })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const member = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id.toLowerCase(),
  is_email_confirmed: true,
  profile: { real_name: `Person ${id}`, email: `${id.toLowerCase()}@acme.test`, image_192: `https://avatars.test/${id}.png` },
  ...overrides,
})

describe('slack directory: verify', () => {
  it('names the workspace and checks both scopes', async () => {
    routes['auth.test'] = () => ({ body: { ok: true, team: 'Acme', team_id: 'T1' }, headers: { 'x-oauth-scopes': 'chat:write,im:write,users:read,users:read.email' } })
    await expect(slackDirectoryProvider.verify({ botToken: 'xoxb-1' })).resolves.toEqual({ tenantId: 'T1', tenantName: 'Acme' })
    expect(calls[0].token).toBe('Bearer xoxb-1')
  })

  it('keys an Enterprise Grid workspace by its enterprise, since user ids span its workspaces', async () => {
    routes['auth.test'] = () => ({ body: { ok: true, team: 'Acme East', team_id: 'T1', enterprise_id: 'E1' }, headers: { 'x-oauth-scopes': 'users:read,users:read.email,chat:write,im:write' } })
    await expect(slackDirectoryProvider.verify({ botToken: 'xoxb-1' })).resolves.toEqual({ tenantId: 'E1', tenantName: 'Acme East' })
  })

  it('connects without the DM scopes, saying invitations won’t go by DM', async () => {
    routes['auth.test'] = () => ({ body: { ok: true, team: 'Acme', team_id: 'T1' }, headers: { 'x-oauth-scopes': 'users:read,users:read.email,chat:write' } })
    expect(await slackDirectoryProvider.verify({ botToken: 'xoxb-1' })).toEqual({
      tenantId: 'T1', tenantName: 'Acme', notices: ['Invitations won’t be sent by Slack DM: the token is missing im:write.'],
    })
  })

  it('refuses a token without the email scope, saying what to add', async () => {
    routes['auth.test'] = () => ({ body: { ok: true, team: 'Acme', team_id: 'T1' }, headers: { 'x-oauth-scopes': 'users:read' } })
    const refused = slackDirectoryProvider.verify({ botToken: 'xoxb-1' })
    await expect(refused).rejects.toBeInstanceOf(DirectoryConnectError)
    await expect(refused).rejects.toThrow('users:read.email')
  })

  it('refuses a token Slack does not accept', async () => {
    routes['auth.test'] = () => ({ body: { ok: false, error: 'invalid_auth' } })
    await expect(slackDirectoryProvider.verify({ botToken: 'xoxb-1' })).rejects.toThrow('does not accept this token')
  })

  it('asks for one page when Slack sends no scope header', async () => {
    routes['auth.test'] = () => ({ body: { ok: true, team: 'Acme', team_id: 'T1' } })
    routes['users.list'] = () => ({ body: { ok: false, error: 'missing_scope' } })
    await expect(slackDirectoryProvider.verify({ botToken: 'xoxb-1' })).rejects.toThrow('missing a scope')
  })

  it('accepts only a bot token', () => {
    expect(slackDirectoryProvider.credentialsSchema.safeParse({ botToken: 'xoxp-user-token' }).success).toBe(false)
    expect(slackDirectoryProvider.credentialsSchema.parse({ botToken: '  xoxb-1 ' })).toEqual({ botToken: 'xoxb-1' })
  })
})

describe('slack directory: listUsers', () => {
  const directory = () => slackDirectoryProvider.open({ id: 'd1', tenantId: 'T1', credentials: { botToken: 'xoxb-1' } })

  it('pages through the workspace and lists people only', async () => {
    routes['users.list'] = (form) => form.get('cursor') === 'page-2'
      ? { body: { ok: true, members: [member('U3'), member('U4', { deleted: true })] } }
      : { body: { ok: true, members: [
          member('U1'),
          member('B1', { is_bot: true }),
          member('A1', { is_app_user: true }),
          member('USLACKBOT'),
          member('G1', { is_restricted: true }),
          member('G2', { is_ultra_restricted: true }),
          member('I1', { is_invited_user: true }),
          member('U2', { is_email_confirmed: false }),
        ], response_metadata: { next_cursor: 'page-2' } } }

    const users = await directory().listUsers()
    expect(users).toEqual([
      { provider: 'slack', tenantId: 'T1', remoteId: 'U1', name: 'Person U1', email: 'u1@acme.test', emailVerified: true, avatarUrl: 'https://avatars.test/U1.png' },
      { provider: 'slack', tenantId: 'T1', remoteId: 'U2', name: 'Person U2', email: 'u2@acme.test', emailVerified: false, avatarUrl: 'https://avatars.test/U2.png' },
      { provider: 'slack', tenantId: 'T1', remoteId: 'U3', name: 'Person U3', email: 'u3@acme.test', emailVerified: true, avatarUrl: 'https://avatars.test/U3.png' },
    ])
    expect(calls.map((call) => [call.form.get('limit'), call.form.get('cursor')])).toEqual([['200', null], ['200', 'page-2']])
  })

  it('falls back through the names Slack has, and has no verified email without one', async () => {
    routes['users.list'] = () => ({ body: { ok: true, members: [{ id: 'U9', name: 'handle', is_email_confirmed: true, profile: { display_name: 'Display' } }] } })
    expect(await directory().listUsers()).toEqual([{ provider: 'slack', tenantId: 'T1', remoteId: 'U9', name: 'Display', emailVerified: false }])
  })

  it('waits out a rate limit', async () => {
    vi.useFakeTimers()
    let limited = true
    routes['users.list'] = () => {
      if (!limited) return { body: { ok: true, members: [member('U1')] } }
      limited = false
      return { status: 429, headers: { 'retry-after': '2' } }
    }
    const listing = directory().listUsers()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await listing).toHaveLength(1)
  })

  it('names what went wrong, for Settings', async () => {
    routes['users.list'] = () => ({ body: { ok: false, error: 'token_revoked' } })
    await expect(directory().listUsers()).rejects.toThrow('does not accept this token')
  })
})

describe('slack directory: notifyUser', () => {
  const directory = () => slackDirectoryProvider.open({ id: 'd1', tenantId: 'T1', credentials: { botToken: 'xoxb-1' } })
  const dana = { provider: 'slack', tenantId: 'T1', remoteId: 'U7', name: 'Dana', email: 'dana@acme.test', emailVerified: true }

  it('opens a DM with the person and posts the message, escaped, with its link', async () => {
    routes['conversations.open'] = (form) => ({ body: { ok: true, channel: { id: `D-${form.get('users')}` } } })
    routes['chat.postMessage'] = () => ({ body: { ok: true } })
    await directory().notifyUser!(dana, {
      headline: 'Ada <admin> shared the agent R&D Helper with you on Gamut.',
      quote: 'first line\nsecond > line',
      link: { label: 'Join Gamut', url: 'https://gamut.test/?invite=abc|def' },
    })
    const post = calls.find((call) => call.method === 'chat.postMessage')!
    expect(post.form.get('channel')).toBe('D-U7')
    expect(post.form.get('text')).toBe([
      'Ada &lt;admin&gt; shared the agent R&amp;D Helper with you on Gamut.',
      '>first line',
      '>second &gt; line',
      '<https://gamut.test/?invite=abc%7Cdef|Join Gamut>',
    ].join('\n'))
  })

  it('says what scope a DM needs when the token lacks it', async () => {
    routes['conversations.open'] = () => ({ body: { ok: false, error: 'missing_scope' } })
    await expect(directory().notifyUser!(dana, { headline: 'Hi', link: { label: 'Join', url: 'https://gamut.test' } }))
      .rejects.toThrow('chat:write and im:write')
  })
})
