import type { ZodType } from 'zod'
import type { IntegrationProviderSetup } from '../agent-integrations/setup-types'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import { IMESSAGE_GATEWAY_URL, imessageSetupSchema, type ChatProvider } from './config-schema'

import { inputSchema, telegramResultSchema, slackResultSchema, tokenResultSchema, telegramTestInputSchema, slackTestInputSchema } from './setup-schema'

/** Both user and agent creation paths use these hooks; API code never exchanges credentials. */
export function chatProviderSetup(provider: ChatProvider, schema: ZodType): IntegrationProviderSetup {
  return {
    allowAgentCreation: true,
    async prepare(input) {
      let config = inputSchema.parse(input)
      if (provider === 'imessage' && config.code && !config.token) {
        const parsed = imessageSetupSchema.parse({ phoneNumber: config.phoneNumber, code: config.code })
        const response = await fetch(`${IMESSAGE_GATEWAY_URL}/auth/exchange`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: parsed.phoneNumber, code: parsed.code }), signal: AbortSignal.timeout(15000),
        })
        if (response.status === 401) throw new IntegrationSetupError('Invalid or expired code')
        if (response.status === 429) throw new IntegrationSetupError('Too many attempts, try again later', 429)
        if (!response.ok) throw new IntegrationSetupError(`Code exchange failed (${response.status})`)
        const { token } = tokenResultSchema.parse(await response.json())
        config = { ...config, token, gatewayUrl: IMESSAGE_GATEWAY_URL }
        delete config.code
      }
      return { config: inputSchema.parse(schema.parse(config)) }
    },
    // iMessage codes can only be verified by consuming them during creation.
    testCredentials: provider === 'imessage' ? undefined : async input => {
      const config = inputSchema.parse(input)
      if (provider === 'telegram') {
        const { botToken } = telegramTestInputSchema.parse(config)
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(15000) })
        const result = telegramResultSchema.parse(await response.json())
        if (!result.ok) throw new IntegrationSetupError('Invalid bot token')
        return { valid: true, botName: result.result?.first_name, botUsername: result.result?.username }
      }
      const { botToken, appToken } = slackTestInputSchema.parse(config)
      const response = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(15000) })
      const result = slackResultSchema.parse(await response.json())
      if (!result.ok) throw new IntegrationSetupError(`Bot token invalid: ${result.error || 'unknown error'}`)
      const socket = await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(15000) })
      const opened = slackResultSchema.parse(await socket.json())
      if (!opened.ok) throw new IntegrationSetupError(`App token invalid: ${opened.error || 'unknown error'}. Ensure Socket Mode is enabled and the token has connections:write scope.`)
      return { valid: true, team: result.team, user: result.user }
    },
  }
}
