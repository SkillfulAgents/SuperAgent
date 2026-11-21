import { isInvokeResponse, PUBLIC } from '@microsoft/teams.api/dist/index.js'
import { App, NegotiateError } from '@microsoft/teams.apps/dist/index.js'
import type { IntegrationInputResult } from '../agent-integrations/types'

// SDK and SignalR diagnostics may contain whole HTTP errors, including request headers.
// Gamut reports socket health from typed status events and exposes only a status code on failure.
const discard = () => {}
const sdkLogger: App['log'] = {
  debug: discard, info: discard, warn: discard, error: discard, trace: discard, log: discard,
  child() { return this },
}

function socketError(error: unknown): Error {
  const status = error instanceof NegotiateError ? error.statusCode : undefined
  if (status === 401) return new Error('Microsoft Teams rejected the development socket credentials (HTTP 401). Check the bot registration and client secret.')
  if (status === 403) return new Error('Microsoft Teams denied the development socket (HTTP 403). Check that Socket Mode is enabled for this bot.')
  return new Error(status ? `Microsoft Teams could not open the development socket (HTTP ${status}).` : 'Microsoft Teams could not open the development socket.')
}

/** Microsoft's authenticated outbound socket is for development and tenant testing. */
export function createTeamsSocket(
  config: { appId: string; tenantId: string; clientSecret: string },
  acceptActivity: (activity: unknown) => Promise<IntegrationInputResult | { status: number; body?: unknown }>,
  onTerminalDisconnect?: (error: Error) => void,
) {
  const app = new App({
    clientId: config.appId, clientSecret: config.clientSecret, tenantId: config.tenantId,
    socketMode: true, cloud: PUBLIC, logger: sdkLogger, client: { logger: sdkLogger },
  })
  let stopped = false
  let terminal = false
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  app.use(async ({ activity }) => {
    if (stopped) return { status: 503 }
    const result = await acceptActivity(activity)
    if (isInvokeResponse(result)) return result
    return { status: result === 'retry' ? 503 : result === 'rejected' ? 403 : 200 }
  })
  app.socketMode!.events.on('disconnected', event => {
    if (event.terminal && !terminal && !stopped) {
      terminal = true
      onTerminalDisconnect?.(socketError(event.error))
    }
  })

  async function start() {
    try {
      await app.initialize()
      if (!stopped) await app.start()
    } catch (error) {
      if (!stopped) throw socketError(error)
    } finally {
      // stop() can race SDK plugin startup before the adapter owns its sockets.
      if (stopped) await app.stop()
    }
  }
  return {
    isReady: () => !stopped && app.socketMode!.status === 'ready',
    start() { return starting ??= start() },
    stop() {
      stopped = true
      // Stop an in-flight negotiate now and wait for any late startup teardown.
      return stopping ??= Promise.allSettled([app.stop(), starting]).then(() => {})
    },
  }
}
