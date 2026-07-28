/**
 * The two Slack identities the harness needs.
 *
 *   BOT    — the chat integration itself. Its token comes straight from the
 *            integration config; used to read what the app posted
 *            (conversations.history), Block Kit payloads included.
 *   SENDER — a second identity in the same workspace that posts the messages a
 *            person would, so inbound traffic takes the real
 *            message → Socket Mode → connector path.
 *
 * A sender is reached one of two ways, and the difference matters:
 *
 *   raw token — the connected account exposes a usable Slack token.
 *   proxy     — Composio refuses to hand out the raw token (it returns a
 *               redacted one) and executes the call server-side instead. This
 *               is the normal case for Composio-managed OAuth connections, so
 *               the harness treats a token that Slack rejects as a signal to
 *               fall back rather than as a dead connection.
 *
 * No token is ever logged.
 */

import { readSettings, readSlackConnectedAccounts } from './data-dir.mjs'

const COMPOSIO_HOST = 'https://backend.composio.dev'
const NANGO_HOST = 'https://api.nango.dev'
const PLATFORM_PROXY_HOST =
  process.env.PLATFORM_PROXY_URL?.replace(/\/+$/, '').replace(/\/v1$/, '') ??
  'https://platformproxy.gamutagents.com'

async function slackWithToken(token, method, params = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  })
  return res.json()
}

/** How composioFetch picks its route: a local key, else the platform proxy. */
function composioRoute(settings, endpoint, apiVersion = 'v3') {
  const key = settings.apiKeys?.composioApiKey
  if (key) return [`${COMPOSIO_HOST}/api/${apiVersion}${endpoint}`, { 'x-api-key': key }]
  const platformToken = settings.platformAuth?.token
  if (!platformToken) throw new Error('neither composioApiKey nor a platform auth token is present')
  return [`${PLATFORM_PROXY_HOST}/v1/composio${endpoint}`, { Authorization: `Bearer ${platformToken}` }]
}

/** Execute a Slack call through Composio, which attaches the auth server-side. */
async function slackViaComposio(settings, connectedAccountId, method, params = {}) {
  const [url, headers] = composioRoute(settings, '/tools/execute/proxy', 'v3.1')
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: `https://slack.com/api/${method}`,
      method: 'POST',
      connected_account_id: connectedAccountId,
      body: params,
    }),
  })
  if (!res.ok) throw new Error(`composio proxy ${res.status} for ${method}`)
  const parsed = await res.json()
  return parsed.data ?? parsed
}

async function composioRawToken(settings, connectedAccountId) {
  const [url, headers] = composioRoute(settings, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`)
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`composio ${res.status}`)
  const json = await res.json()
  const val = json.state?.val ?? {}
  return val.access_token ?? val.oauth_token ?? val.api_key ?? val.generic_api_key ?? null
}

async function nangoRawToken(settings, connectionId) {
  const key = settings.apiKeys?.nangoSecretKey
  if (!key) throw new Error('nangoSecretKey missing from settings')
  const url =
    `${NANGO_HOST}/connections/${encodeURIComponent(connectionId)}` +
    `?provider_config_key=slack&force_refresh=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`nango ${res.status}`)
  const creds = (await res.json()).credentials ?? {}
  return creds.access_token ?? creds.oauth_token ?? creds.api_key ?? null
}

/** Every way one connected account might be able to speak Slack, in order. */
async function candidateCallers(settings, account) {
  const callers = []
  try {
    const token =
      account.provider_name === 'nango'
        ? await nangoRawToken(settings, account.provider_connection_id)
        : await composioRawToken(settings, account.provider_connection_id)
    if (token) {
      callers.push({
        via: 'token',
        call: (method, params) => slackWithToken(token, method, params),
      })
    }
  } catch (err) {
    callers.push({ via: 'token', error: err.message })
  }
  if (account.provider_name !== 'nango') {
    callers.push({
      via: 'composio-proxy',
      call: (method, params) =>
        slackViaComposio(settings, account.provider_connection_id, method, params),
    })
  }
  return callers
}

/**
 * Find a connected account that can post into the bot's workspace as somebody
 * other than the integration itself.
 *
 * A human (user) identity is preferred: it is the only shape that can open a DM
 * with the bot, which is how the feature is actually used. A second app's bot
 * identity is the accepted fallback — Slack delivers its posts as ordinary
 * `message` events with no subtype, so the connector's inbound path treats them
 * exactly like a person's, but they can only reach a shared channel.
 */
export async function resolveSender(sourceDataDir, botAuth, log = () => {}, { requireHuman = false } = {}) {
  const settings = readSettings(sourceDataDir)
  const accounts = readSlackConnectedAccounts(sourceDataDir).filter((a) => a.status === 'active')
  const rejected = []
  const appFallbacks = []

  for (const account of accounts) {
    for (const caller of await candidateCallers(settings, account)) {
      const label = `${account.provider_name}:${account.provider_connection_id} (${caller.via})`
      if (caller.error) {
        rejected.push(`${label} — ${caller.error}`)
        continue
      }
      let auth
      try {
        auth = await caller.call('auth.test')
      } catch (err) {
        rejected.push(`${label} — ${err.message}`)
        continue
      }
      if (!auth?.ok) {
        rejected.push(`${label} — auth.test failed (${auth?.error ?? 'no response'})`)
        continue
      }
      if (auth.team_id !== botAuth.team_id) {
        rejected.push(`${label} — workspace ${auth.team ?? auth.team_id}, not the bot's`)
        continue
      }
      if (auth.user_id === botAuth.user_id) {
        rejected.push(`${label} — this is the integration's own identity`)
        continue
      }
      const sender = { auth, call: caller.call, accountId: account.id, label, via: caller.via }
      if (auth.bot_id) {
        appFallbacks.push({ ...sender, kind: 'app' })
        continue
      }
      log(`sender: human ${auth.user} (${auth.user_id}) in ${auth.team} via ${label}`)
      return { ...sender, kind: 'human', rejected }
    }
  }

  if (requireHuman) {
    const detail = rejected.length ? `\n  ${rejected.join('\n  ')}` : ''
    throw new Error(`No human Slack identity in this install.${detail}`)
  }

  if (appFallbacks.length > 0) {
    const pick = appFallbacks[0]
    log(
      `sender: app ${pick.auth.user} (${pick.auth.user_id}) in ${pick.auth.team} via ${pick.label} ` +
        `— no human identity available, so the surface will be a shared channel`,
    )
    return { ...pick, rejected }
  }

  const detail = rejected.length ? `\n  ${rejected.join('\n  ')}` : ''
  throw new Error(
    `No Slack connected account can post into the bot's workspace as another identity.${detail}`,
  )
}

/**
 * Try each data dir in turn for a usable sender.
 *
 * The integration's install and the install holding the personal Slack
 * connection are routinely different (the packaged app is where people
 * actually connect their accounts), so "no sender here" is a reason to look in
 * the next install, not to stop. Every dir is read-only.
 */
export async function resolveSenderAcross(dirs, botAuth, log = () => {}) {
  const candidates = dirs.filter(Boolean)
  const tried = []
  // A human anywhere beats an app identity everywhere: only a human can open
  // the DM, which is the surface the feature is actually used on.
  for (const requireHuman of [true, false]) {
    for (const dir of candidates) {
      try {
        const sender = await resolveSender(dir, botAuth, log, { requireHuman })
        return { ...sender, sourceDir: dir }
      } catch (err) {
        if (!requireHuman) tried.push(`${dir}:\n    ${err.message.split('\n').join('\n    ')}`)
      }
    }
  }
  throw new Error(`No usable Slack sender in any candidate install.\n  ${tried.join('\n  ')}`)
}

/** Bot identity, and a hard failure if the integration's token is dead. */
export async function resolveBot(botToken) {
  const auth = await slackWithToken(botToken, 'auth.test')
  if (!auth.ok) throw new Error(`Slack bot token rejected: ${auth.error}`)
  return auth
}

/**
 * The DM channel between the sender and the bot, opened from the SENDER side so
 * the id is the same one a real person's messages arrive on.
 */
export async function openDirectMessage(sender, botUserId) {
  const res = await sender.call('conversations.open', { users: botUserId })
  if (!res.ok) throw new Error(`conversations.open failed: ${res.error}`)
  return res.channel.id
}

/** Post as the sender. Returns the message ts. */
export async function sendAsSender(sender, channel, text) {
  const res = await sender.call('chat.postMessage', { channel, text })
  if (!res.ok) throw new Error(`sender chat.postMessage failed: ${res.error}`)
  return res.ts
}

/**
 * Messages in the channel strictly after `sinceTs`, oldest first, read with the
 * BOT token so we see exactly what the integration published.
 */
export async function messagesSince(botToken, channel, sinceTs, limit = 200) {
  const res = await slackWithToken(botToken, 'conversations.history', {
    channel,
    oldest: sinceTs,
    inclusive: false,
    limit,
  })
  if (!res.ok) throw new Error(`conversations.history failed: ${res.error}`)
  return (res.messages ?? []).slice().reverse()
}

/** Latest ts in the channel — the watermark a step reads forward from. */
export async function currentWatermark(botToken, channel) {
  const res = await slackWithToken(botToken, 'conversations.history', { channel, limit: 1 })
  if (!res.ok) throw new Error(`conversations.history failed: ${res.error}`)
  return res.messages?.[0]?.ts ?? '0'
}

/** Channel ids an identity is a member of. `who` is a bot token or a sender. */
export async function memberChannels(who) {
  const params = { types: 'public_channel,private_channel', limit: 200, exclude_archived: true }
  const res = typeof who === 'string'
    ? await slackWithToken(who, 'users.conversations', params)
    : await who.call('users.conversations', params)
  if (!res.ok) throw new Error(`users.conversations failed: ${res.error}`)
  return (res.channels ?? []).map((c) => ({ id: c.id, name: c.name, isPrivate: !!c.is_private }))
}

export async function joinChannel(sender, channelId) {
  return sender.call('conversations.join', { channel: channelId })
}

/** Every button action_id in a message's Block Kit payload. */
export function buttonActionIds(message) {
  const ids = []
  for (const block of message.blocks ?? []) {
    if (block.type !== 'actions') continue
    for (const el of block.elements ?? []) {
      if (el.type === 'button' && el.action_id) ids.push(el.action_id)
    }
  }
  return ids
}

/** Button labels in a message, in render order. */
export function buttonLabels(message) {
  const labels = []
  for (const block of message.blocks ?? []) {
    if (block.type !== 'actions') continue
    for (const el of block.elements ?? []) {
      if (el.type === 'button') labels.push(el.text?.text ?? '')
    }
  }
  return labels
}

/**
 * Undo Slack's on-the-wire encoding so an assertion can compare against the
 * text the app actually posted.
 *
 * Slack auto-links bare URLs and hands them back wrapped in angle brackets
 * (`<https://…>`, or `<url|label>` when a label is present), and escapes
 * &, < and >. None of that is in what the connector sent, so comparing raw
 * would fail on every notice that ends in a link — which is all of them.
 */
export function normalizeSlackText(text) {
  return text
    .replace(/<((?:https?|[a-z][a-z0-9+.-]*):\/\/[^|>]+)(?:\|[^>]*)?>/gi, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** All human-readable text in a message: top-level text plus every block. */
export function messageText(message) {
  const parts = [message.text ?? '']
  for (const block of message.blocks ?? []) {
    if (block.text?.text) parts.push(block.text.text)
    for (const field of block.fields ?? []) if (field.text) parts.push(field.text)
  }
  return normalizeSlackText(parts.join('\n'))
}
