import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { WebClient } from '@slack/web-api'
import { SlackConnector } from './slack-connector'
import type { IncomingMessage } from './base-connector'

// ---------------------------------------------------------------------------
// LIVE Slack connector validation. Gated: runs only with SLACK_LIVE=1 and real
// credentials — never in CI.
//
//   SLACK_LIVE=1 \
//   SLACK_LIVE_CONFIG=/path/to/slack-config.json \        # {botToken, appToken}
//   SLACK_LIVE_CONNECTION_ID=<composio connected acct> \  # optional: user-send step
//   SUPERAGENT_DATA_DIR="$HOME/Library/Application Support/Superagent-Dev" \
//   npx vitest run src/shared/lib/chat-integrations/slack-connector.live.test.ts
//
// Validates, against a real Slack workspace:
//   1. connect with honest isConnected(),
//   2. a hard websocket kill (sleep/network-cut simulation) is detected and
//      self-healed by the connector's own reconnect loop,
//   3. the recovered socket actually delivers events (raw envelope check),
//   4. a USER-authored message (sent via the Composio connected account, i.e.
//      "on the user's behalf") flows through the full inbound path to
//      onMessage,
//   5. outbound sendMessage works on the recovered connection.
//
// NOTE: if another app instance holds a Socket Mode connection for the same
// Slack app, Slack load-balances events across connections — event-delivery
// assertions retry several sends to tolerate that.
// ---------------------------------------------------------------------------

const LIVE = process.env.SLACK_LIVE === '1'

interface LiveConfig { botToken: string; appToken: string }

function loadConfig(): LiveConfig {
  const path = process.env.SLACK_LIVE_CONFIG
  if (!path) throw new Error('SLACK_LIVE_CONFIG not set')
  return JSON.parse(readFileSync(path, 'utf8')) as LiveConfig
}

async function waitFor(
  label: string,
  cond: () => boolean,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  console.log(`[live] ${label} after ${Date.now() - start}ms`)
}

describe.runIf(LIVE)('SlackConnector live validation', () => {
  let config: LiveConfig
  let connector: SlackConnector
  let botClient: WebClient
  let channelId: string
  const received: IncomingMessage[] = []
  const rawEnvelopes: Array<{ type: string; ts: number }> = []

  /** The Socket Mode client inside the connector's receiver. */
  function socketClient(): {
    on: (ev: string, cb: (...a: unknown[]) => void) => void
    websocket?: { websocket?: { terminate: () => void } }
  } {
    const receiver = (connector as unknown as { receiver: { client: unknown } }).receiver
    if (!receiver) throw new Error('connector has no receiver')
    return receiver.client as ReturnType<typeof socketClient>
  }

  beforeAll(async () => {
    config = loadConfig()
    connector = new SlackConnector({ botToken: config.botToken, appToken: config.appToken })
    connector.onMessage((msg) => {
      console.log(`[live] onMessage: chat=${msg.chatId} user=${msg.userName ?? msg.userId} text=${JSON.stringify(msg.text.slice(0, 80))}`)
      received.push(msg)
    })

    botClient = new WebClient(config.botToken)

    await connector.connect()

    // Observe raw envelopes: proves transport delivery independent of Bolt's
    // self-message filtering.
    socketClient().on('slack_event', (...args: unknown[]) => {
      const evt = args[0] as { body?: { event?: { type?: string } } }
      const type = evt?.body?.event?.type ?? 'unknown'
      rawEnvelopes.push({ type, ts: Date.now() })
    })

    // Find a channel the bot is a member of.
    const convos = await botClient.users.conversations({
      types: 'public_channel,private_channel',
      limit: 100,
    })
    const first = convos.channels?.[0]
    if (!first?.id) throw new Error('Bot is not a member of any channel — invite it to one first')
    channelId = first.id
    console.log(`[live] using channel ${channelId} (#${first.name}); bot channels: ${convos.channels?.length}`)
  }, 60_000)

  afterAll(async () => {
    await connector?.disconnect()
  })

  /** Post as the BOT and wait for any raw envelope to arrive on our socket. */
  async function proveTransportDelivers(tag: string): Promise<void> {
    const before = rawEnvelopes.length
    for (let attempt = 1; attempt <= 4; attempt++) {
      await botClient.chat.postMessage({ channel: channelId, text: `:satellite: harness transport ping ${tag} #${attempt}` })
      try {
        await waitFor(`raw envelope (${tag}, attempt ${attempt})`, () => rawEnvelopes.length > before, 8_000)
        return
      } catch {
        console.log(`[live] no envelope on attempt ${attempt} — possible competing Socket Mode connection, retrying`)
      }
    }
    throw new Error(`No raw envelope arrived after 4 sends (${tag})`)
  }

  it('connects with honest state', async () => {
    expect(connector.isConnected()).toBe(true)
    await proveTransportDelivers('baseline')
  }, 60_000)

  it('detects a hard socket kill and self-heals via its own reconnect loop', async () => {
    const client = socketClient()
    const raw = client.websocket?.websocket
    if (!raw) throw new Error('no underlying websocket to terminate')

    console.log('[live] terminating raw websocket (sleep/network-cut simulation)')
    raw.terminate()

    // Honest state: the drop must be visible…
    await waitFor('isConnected() === false after kill', () => !connector.isConnected(), 10_000, 50)

    // …and the connector's own loop must restore it without any manager help.
    await waitFor('isConnected() === true after self-reconnect', () => connector.isConnected(), 30_000)

    await proveTransportDelivers('post-recovery')
  }, 90_000)

  it('delivers a USER-authored message through the full inbound path after recovery', async () => {
    const connectionIds = (process.env.SLACK_LIVE_CONNECTION_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (connectionIds.length === 0) {
      console.warn('[live] SLACK_LIVE_CONNECTION_ID not set — skipping user-send step')
      return
    }

    const { getConnectionToken, proxyExecute } = await import('@shared/lib/composio/client')

    const sendAsUserVia = async (connectionId: string, text: string): Promise<void> => {
      // "nango:<provider_connection_id>" → direct-forward via the Nango provider
      // (used for connections whose auth lives in Nango rather than Composio).
      if (connectionId.startsWith('nango:')) {
        const { registerAllAccountProviders } = await import('@shared/lib/account-providers/register')
        const { getAccountProvider } = await import('@shared/lib/account-providers/provider-factory')
        registerAllAccountProviders()
        const nango = getAccountProvider('nango')
        const payload = new TextEncoder().encode(JSON.stringify({ channel: channelId, text }))
        const res = await nango.makeApiCall({
          providerConnectionId: connectionId.slice('nango:'.length),
          toolkitSlug: 'slack',
          targetUrl: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
        })
        const data = await res.json() as { ok?: boolean; error?: string; ts?: string }
        console.log(`[live] user-send via nango (${connectionId}) status=${res.status} ok=${data?.ok} error=${data?.error ?? ''} ts=${data?.ts ?? ''}`)
        if (!data?.ok) throw new Error(`nango user-send failed: ${data?.error}`)
        return
      }
      try {
        const { accessToken } = await getConnectionToken(connectionId)
        const userClient = new WebClient(accessToken)
        const res = await userClient.chat.postMessage({ channel: channelId, text })
        console.log(`[live] user-send via token (${connectionId}) ok=${res.ok} ts=${res.ts}`)
      } catch (err) {
        console.log(`[live] token path unavailable for ${connectionId} (${err instanceof Error ? err.message.slice(0, 80) : err}) — using composio proxy`)
        const res = await proxyExecute({
          endpoint: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          connectedAccountId: connectionId,
          body: { channel: channelId, text },
        })
        const data = res.data as { ok?: boolean; error?: string }
        console.log(`[live] user-send via proxy (${connectionId}) status=${res.status} ok=${data?.ok} error=${data?.error ?? ''}`)
        if (!data?.ok) throw new Error(`proxy user-send failed: ${data?.error}`)
      }
    }

    // Multiple candidate connected accounts may exist; use the first that works.
    let workingId: string | null = null
    const sendAsUser = async (text: string): Promise<void> => {
      if (workingId) return sendAsUserVia(workingId, text)
      let lastErr: unknown
      for (const id of connectionIds) {
        try {
          await sendAsUserVia(id, text)
          workingId = id
          return
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const marker = `harness user ping ${Date.now()}#${attempt}`
      const before = received.length
      await sendAsUser(marker)
      try {
        await waitFor(
          `onMessage with marker (attempt ${attempt})`,
          () => received.slice(before).some((m) => m.text.includes(marker)),
          15_000,
        )
        const match = received.slice(before).find((m) => m.text.includes(marker))!
        expect(match.chatId).toBe(channelId)
        expect(match.userId).toBeTruthy()
        return
      } catch {
        console.log(`[live] marker not received on attempt ${attempt} — possible competing connection, retrying`)
      }
    }
    throw new Error('User-authored message never reached onMessage in 3 attempts')
  }, 120_000)

  it('sends outbound on the recovered connection', async () => {
    const ts = await connector.sendMessage(channelId, {
      text: ':white_check_mark: harness outbound after recovery',
    })
    expect(ts).toBeTruthy()
    console.log(`[live] outbound ok ts=${ts}`)
  }, 30_000)
})
