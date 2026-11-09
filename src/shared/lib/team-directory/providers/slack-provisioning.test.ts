import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryConnectError, ProvisioningCredentialsError } from '../types'
import { slackAppProvisioning } from './slack-provisioning'

type Route = (body: URLSearchParams | FormData) => { status?: number; body?: unknown }
let routes: Record<string, Route>
let calls: Array<{ method: string; body: URLSearchParams | FormData; token: string | null }>

beforeEach(() => {
  calls = []
  routes = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = url.replace('https://slack.com/api/', '')
    const body = init.body instanceof FormData ? init.body : new URLSearchParams(init.body as URLSearchParams)
    calls.push({ method, body, token: new Headers(init.headers).get('authorization') })
    const route = routes[method]
    if (!route) return new Response(JSON.stringify({ ok: false, error: 'unknown_method' }))
    const { status = 200, body: answer = {} } = route(body)
    return new Response(JSON.stringify(answer), { status })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const pair = { accessToken: 'xoxe.xoxp-1-access', refreshToken: 'xoxe-1-refresh' }
const rotated = (n = 2) => ({ ok: true, token: `xoxe.xoxp-1-access-${n}`, refresh_token: `xoxe-1-refresh-${n}`, exp: 1_800_000_000, team_id: 'T1', user_id: 'U_ADMIN' })
const record = { appId: 'A123', clientId: '111.222', clientSecret: 'shh' }
const provisioner = () => slackAppProvisioning.open({ ...pair, expiresAt: Date.now() + 3_600_000, teamId: 'T1' })

describe('slack app configuration token', () => {
  it('is verified by rotating it once, and must be for the directory’s workspace', async () => {
    routes['tooling.tokens.rotate'] = () => ({ body: rotated() })
    expect(await slackAppProvisioning.verify(pair, { tenantId: 'T1' })).toEqual({
      accessToken: 'xoxe.xoxp-1-access-2', refreshToken: 'xoxe-1-refresh-2', expiresAt: 1_800_000_000_000, teamId: 'T1', userId: 'U_ADMIN',
    })
    expect(calls[0]).toMatchObject({ method: 'tooling.tokens.rotate', token: null })
    expect(calls[0].body.get('refresh_token')).toBe('xoxe-1-refresh')
    await expect(slackAppProvisioning.verify(pair, { tenantId: 'T9' })).rejects.toThrow('another Slack workspace')
    // A grid directory spans its workspaces.
    await expect(slackAppProvisioning.verify(pair, { tenantId: 'E1' })).resolves.toMatchObject({ teamId: 'T1' })
  })

  it('refuses a refresh token Slack no longer renews', async () => {
    routes['tooling.tokens.rotate'] = () => ({ body: { ok: false, error: 'invalid_refresh_token' } })
    await expect(slackAppProvisioning.verify(pair, { tenantId: 'T1' })).rejects.toBeInstanceOf(DirectoryConnectError)
    await expect(slackAppProvisioning.rotate!(pair)).rejects.toBeInstanceOf(ProvisioningCredentialsError)
  })

  it('treats an outage as passing, not as a broken chain', async () => {
    routes['tooling.tokens.rotate'] = () => ({ status: 500 })
    const failure = slackAppProvisioning.rotate!(pair)
    await expect(failure).rejects.toThrow()
    await expect(failure).rejects.not.toBeInstanceOf(ProvisioningCredentialsError)
  })

  it('is due an hour before it expires', () => {
    const now = 1_000_000
    expect(slackAppProvisioning.needsRotation!({ ...pair }, now)).toBe(true)
    expect(slackAppProvisioning.needsRotation!({ ...pair, expiresAt: now + 2 * 3_600_000 }, now)).toBe(false)
    expect(slackAppProvisioning.needsRotation!({ ...pair, expiresAt: now + 30 * 60_000 }, now)).toBe(true)
  })

  it('takes only configuration tokens', () => {
    expect(slackAppProvisioning.credentialsSchema.safeParse({ accessToken: 'xoxb-bot', refreshToken: 'xoxe-1' }).success).toBe(false)
  })

  it('needs only the refresh token pasted, and names the access token when that is pasted instead', async () => {
    const asked = slackAppProvisioning.info.fields.map((field) => field.key)
    expect(asked).toEqual(['refreshToken'])
    const pasted = slackAppProvisioning.credentialsSchema.parse({ refreshToken: ' xoxe-1-refresh ' })
    routes['tooling.tokens.rotate'] = () => ({ body: rotated() })
    // No workspace yet: the token names its own (a directory being connected with it).
    expect(await slackAppProvisioning.verify(pasted)).toMatchObject({ accessToken: 'xoxe.xoxp-1-access-2', teamId: 'T1' })
    expect(calls[0].body.get('refresh_token')).toBe('xoxe-1-refresh')

    const wrong = slackAppProvisioning.credentialsSchema.safeParse({ refreshToken: 'xoxe.xoxp-1-access' })
    expect(wrong.success).toBe(false)
    expect(wrong.error?.issues[0]?.message).toBe('That’s the access token. Paste the refresh token, the one that starts with xoxe-')
  })
})

describe('slack directory app', () => {
  it('creates the directory’s own app, with its scopes and no events, for the host to install', async () => {
    routes['apps.manifest.create'] = () => ({ body: {
      ok: true, app_id: 'ADIR',
      credentials: { client_id: '333.444', client_secret: 'dir-secret', signing_secret: 'unused' },
      oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=333.444&scope=users:read',
    } })
    const created = await slackAppProvisioning.createDirectoryApp!({ ...pair, expiresAt: Date.now() + 3_600_000 }, { redirectUrl: 'https://gamut.example/api/team-directories/install/callback' })
    expect(created).toEqual({
      app: { appId: 'ADIR', clientId: '333.444', clientSecret: 'dir-secret' },
      installUrl: 'https://slack.com/oauth/v2/authorize?client_id=333.444&scope=users:read',
    })
    expect(calls[0].token).toBe('Bearer xoxe.xoxp-1-access')
    const manifest = JSON.parse(calls[0].body.get('manifest') as string)
    expect(manifest.oauth_config).toEqual({
      scopes: { bot: ['users:read', 'users:read.email', 'chat:write', 'im:write'] },
      redirect_urls: ['https://gamut.example/api/team-directories/install/callback'],
    })
    expect(manifest.settings.event_subscriptions).toBeUndefined()

    // Installing it gives the directory's bot token, which is what the Slack directory connects with.
    routes['oauth.v2.access'] = () => ({ body: { ok: true, access_token: 'xoxb-directory' } })
    expect(await provisioner().completeInstall(created.app, 'code-1', 'https://gamut.example/api/team-directories/install/callback')).toEqual({ botToken: 'xoxb-directory' })
  })

  it('tells the admin to start again when Slack refuses to create it', async () => {
    routes['apps.manifest.create'] = () => ({ body: { ok: false, error: 'invalid_manifest' } })
    await expect(slackAppProvisioning.createDirectoryApp!({ ...pair }, { redirectUrl: 'https://gamut.example/cb' }))
      .rejects.toThrow(new DirectoryConnectError('Slack did not create the app (invalid_manifest). Generate a new token and try again.'))
  })
})

describe('slack agent apps', () => {
  it('creates the app from its manifest, with the webhook and callback, then sets its icon', async () => {
    routes['apps.manifest.create'] = () => ({ body: {
      ok: true, app_id: 'A123',
      credentials: { client_id: '111.222', client_secret: 'shh', signing_secret: 'sign' },
      oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=111.222&scope=chat:write',
    } })
    routes['apps.icon.set'] = () => ({ body: { ok: true } })

    const created = await provisioner().createApp({
      name: 'Support Desk', description: 'Answers support', backgroundColor: '#123456', icon: new Uint8Array([0x89, 0x50]),
      webhookUrl: 'https://relay.test/hook', redirectUrl: 'https://app.test/api/agent-integrations/providers/slack/callback',
    })
    const manifest = JSON.parse(calls[0].body.get('manifest') as string)
    expect(calls[0].token).toBe('Bearer xoxe.xoxp-1-access')
    expect(manifest).toMatchObject({
      display_information: { name: 'Support Desk', description: 'Answers support', background_color: '#123456' },
      features: { bot_user: { display_name: 'Support Desk' } },
      oauth_config: { redirect_urls: ['https://app.test/api/agent-integrations/providers/slack/callback'] },
      settings: { event_subscriptions: { request_url: 'https://relay.test/hook' }, socket_mode_enabled: false },
    })
    expect(calls[1].method).toBe('apps.icon.set')
    expect(calls[1].body.get('app_id')).toBe('A123')
    expect(calls[1].body.get('file')).toBeInstanceOf(Blob)
    expect(created).toMatchObject({
      app: record, config: { signingSecret: 'sign' }, iconSet: true,
      installUrl: 'https://slack.com/oauth/v2/authorize?client_id=111.222&scope=chat:write',
      verification: { header: 'x-slack-signature', secret: 'sign' },
      settingsUrl: 'https://api.slack.com/apps/A123',
    })
  })

  it('still creates the app when its icon fails, for it to be set again later', async () => {
    routes['apps.manifest.create'] = () => ({ body: { ok: true, app_id: 'A1', credentials: { client_id: 'c', client_secret: 's', signing_secret: 'g' }, oauth_authorize_url: 'https://slack.com/oauth/v2/authorize' } })
    routes['apps.icon.set'] = () => ({ body: { ok: false, error: 'invalid_icon_size' } })
    const created = await provisioner().createApp({ name: 'A', icon: new Uint8Array([1]), webhookUrl: 'https://relay.test/h', redirectUrl: 'https://app.test/cb' })
    expect(created.iconSet).toBe(false)
  })

  it('exchanges the install code for the bot token', async () => {
    routes['oauth.v2.access'] = () => ({ body: { ok: true, access_token: 'xoxb-new-bot' } })
    expect(await provisioner().completeInstall(record, 'the-code', 'https://app.test/cb')).toEqual({ botToken: 'xoxb-new-bot' })
    expect(calls[0].token).toBeNull()
    expect(Object.fromEntries(calls[0].body as URLSearchParams)).toEqual({ client_id: '111.222', client_secret: 'shh', code: 'the-code', redirect_uri: 'https://app.test/cb' })
  })

  it('renames the app and its @handle, keeping the rest of its manifest', async () => {
    routes['apps.manifest.export'] = () => ({ body: { ok: true, manifest: {
      display_information: { name: 'Old', description: 'kept' },
      features: { bot_user: { display_name: 'Old', always_online: true }, app_home: { messages_tab_enabled: true } },
      settings: { event_subscriptions: { request_url: 'https://relay.test/hook' } },
    } } })
    routes['apps.manifest.update'] = () => ({ body: { ok: true } })
    await provisioner().updateApp(record, { name: 'Help Desk' })
    const manifest = JSON.parse(calls[1].body.get('manifest') as string)
    expect(manifest).toEqual({
      display_information: { name: 'Help Desk', description: 'kept' },
      features: { bot_user: { display_name: 'Help Desk', always_online: true }, app_home: { messages_tab_enabled: true } },
      settings: { event_subscriptions: { request_url: 'https://relay.test/hook' } },
    })
    expect(calls[1].body.get('app_id')).toBe('A123')
  })

  it('deletes the app', async () => {
    routes['apps.manifest.delete'] = () => ({ body: { ok: true } })
    await provisioner().deleteApp(record)
    expect(calls[0]).toMatchObject({ method: 'apps.manifest.delete', token: 'Bearer xoxe.xoxp-1-access' })
    expect(calls[0].body.get('app_id')).toBe('A123')
  })
})
