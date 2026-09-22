import { afterEach, expect, it, vi } from 'vitest'
import { chatProviderSetup } from './setup'
import { telegramConfigSchema, slackConfigSchema, imessageConfigSchema, IMESSAGE_GATEWAY_URL } from './config-schema'
const context = { agentSlug: 'agent', callbackUrl: 'https://host/callback' }
afterEach(() => vi.unstubAllGlobals())
it('validates Telegram credentials and stores only schema-defined config', async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true, result: { first_name: 'Agent', username: 'agent_bot' } }))
  vi.stubGlobal('fetch', fetch)
  const setup = chatProviderSetup('telegram', telegramConfigSchema)
  expect(await setup.testCredentials!({ botToken: 'token' })).toEqual({ valid: true, botName: 'Agent', botUsername: 'agent_bot' })
  expect(await setup.prepare({ botToken: 'token', ignored: 'value' }, context)).toEqual({ config: { botToken: 'token' } })
  expect(fetch).toHaveBeenCalledOnce()
})
it('checks both Slack tokens and propagates a Socket Mode rejection', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, team: 'Team', user: 'U1' }))
    .mockResolvedValueOnce(Response.json({ ok: false, error: 'missing_scope' }))
  vi.stubGlobal('fetch', fetch)
  const setup = chatProviderSetup('slack', slackConfigSchema)
  await expect(setup.testCredentials!({ botToken: 'bot', appToken: 'app' })).rejects.toThrow('missing_scope')
  expect(fetch.mock.calls[1]).toEqual(['https://slack.com/api/apps.connections.open', expect.objectContaining({ headers: { Authorization: 'Bearer app' } })])
})
it('does not claim iMessage credentials are verified before exchanging the code on creation', async () => {
  const fetch = vi.fn(async () => Response.json({ token: 'issued-token' }))
  vi.stubGlobal('fetch', fetch)
  const setup = chatProviderSetup('imessage', imessageConfigSchema)
  const input = { phoneNumber: '+15555550100', code: '123456' }
  expect(setup.testCredentials).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
  expect(await setup.prepare(input, context)).toEqual({ config: { phoneNumber: input.phoneNumber, token: 'issued-token', gatewayUrl: IMESSAGE_GATEWAY_URL } })
  expect(fetch).toHaveBeenCalledOnce()
  expect(input.code).toBe('123456')
})
it.each([[401, 400], [403, 400], [429, 429]])('maps iMessage gateway status %s to setup status %s', async (status, setupStatus) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
  await expect(chatProviderSetup('imessage', imessageConfigSchema).prepare({ phoneNumber: '+15555550100', code: '123456' }, context)).rejects.toMatchObject({ status: setupStatus })
})
