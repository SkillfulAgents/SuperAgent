#!/usr/bin/env node
/**
 * Preflight for the Slack chat-integration validation harness.
 *
 * Proves the environment can run the suite before anything is seeded or
 * booted — the slow, stateful parts should never fail for a reason a five
 * second check could have surfaced:
 *
 *   1. the source data dir exists and holds exactly one Slack integration,
 *   2. its bot token still authenticates,
 *   3. some connected account authenticates as a HUMAN in the same workspace,
 *   4. the DM between them opens,
 *   5. docker and the agent image the seed will boot against are present,
 *   6. nothing else is already holding this Slack app's Socket Mode session.
 *
 * Run:  node e2e/live/slack-chat/preflight.mjs [--source=<data dir>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_SOURCE_DATA_DIR, PACKAGED_DATA_DIR, readSettings, readSlackIntegration } from './lib/data-dir.mjs'
import { resolveBot, resolveSenderAcross, currentWatermark } from './lib/slack.mjs'
import { resolveSurface } from './lib/surface.mjs'
import { containerPortRangeConflicts } from './lib/app.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.join('=') || true]
  }),
)

const SOURCE = args.source || process.env.SLACK_VALIDATION_SOURCE_DIR || DEFAULT_SOURCE_DATA_DIR

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

export async function preflight({ source = SOURCE, log = console.log } = {}) {
  if (!existsSync(source)) throw new Error(`Source data dir not found: ${source}`)
  log(`source data dir: ${source}`)

  const integration = readSlackIntegration(source)
  check('exactly one Slack integration in the source data dir', true, `agent=${integration.agent_slug} showToolCalls=${integration.show_tool_calls}`)

  const settings = readSettings(source)
  check(
    'settings carry an LLM key the seeded app can run turns with',
    Boolean(settings.apiKeys?.anthropicApiKey) || settings.llmProvider === 'platform',
    settings.apiKeys?.anthropicApiKey ? 'anthropicApiKey present' : `llmProvider=${settings.llmProvider}`,
  )

  const botAuth = await resolveBot(integration.config.botToken)
  check('bot token authenticates', true, `${botAuth.user} (${botAuth.user_id}) in ${botAuth.team}`)

  // The sender's credentials may live in a different install than the
  // integration's (e.g. the packaged app holds the personal Slack connection
  // while the dev install holds the bot). Both are read-only here.
  const senderDirs = args['sender-source'] || process.env.SLACK_VALIDATION_SENDER_DIR
    ? [args['sender-source'] || process.env.SLACK_VALIDATION_SENDER_DIR]
    : [source, PACKAGED_DATA_DIR]
  const sender = await resolveSenderAcross(senderDirs, botAuth, (m) => log(`  ${m}`))
  if (sender.sourceDir !== source) log(`  sender credentials came from ${sender.sourceDir}`)
  check(
    'a connected account can post as a second identity in the same workspace',
    true,
    `${sender.kind} ${sender.auth.user} via ${sender.label}`,
  )

  const surface = await resolveSurface({
    sender,
    botToken: integration.config.botToken,
    botAuth,
    preferred: args.channel || process.env.SLACK_VALIDATION_CHANNEL,
    log: (m) => log(`  ${m}`),
  })
  const watermark = await currentWatermark(integration.config.botToken, surface.channelId)
  check(
    'the conversation to drive is reachable',
    true,
    `${surface.label} (${surface.channelId}, watermark ${watermark})`,
  )

  let dockerOk = false
  let images = ''
  try {
    images = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
    dockerOk = true
  } catch {
    /* reported below */
  }
  check('docker is reachable', dockerOk)
  const wantImage = settings.container?.agentImage ?? 'superagent-container:latest'
  check(`agent image ${wantImage} exists locally`, images.split('\n').includes(wantImage))

  const basePort = Number(args['container-base-port'] ?? 5300)
  const conflicts = await containerPortRangeConflicts(basePort)
  check(
    `container publish range ${basePort}-${basePort + 7} is free`,
    conflicts.length === 0,
    conflicts.length
      ? `busy: ${conflicts.join(', ')} — a loopback listener there silently steals host→container traffic`
      : '',
  )

  // One Socket Mode session per app token wins the events; a second one makes
  // Slack load-balance and the suite goes nondeterministically quiet.
  const competing = detectCompetingHosts(source)
  check(
    'no other Superagent instance is holding this Slack app',
    competing.length === 0,
    competing.length ? competing.join('; ') : 'no running app with an active Slack integration',
  )

  return { source, integration, settings, botAuth, sender, surface, watermark, ok: results.every((r) => r.ok) }
}

/**
 * Any *running* Superagent process whose data dir holds an ACTIVE Slack
 * integration would compete for the same Socket Mode session. Paused rows are
 * harmless; so is a data dir nobody is running.
 */
function detectCompetingHosts(source) {
  const found = []
  let ps = ''
  try {
    ps = execFileSync('ps', ['ax', '-o', 'command'], { encoding: 'utf8' })
  } catch {
    return found
  }
  const running = {
    packaged: /\/(Gamut|Superagent)\.app\/Contents\/MacOS\//.test(ps),
    electronDev: /electron-vite dev/.test(ps),
  }
  const candidates = [
    ['packaged app', path.join(process.env.HOME, 'Library', 'Application Support', 'Superagent'), running.packaged],
    ['electron dev', DEFAULT_SOURCE_DATA_DIR, running.electronDev],
  ]
  for (const [label, dir, isRunning] of candidates) {
    if (!isRunning || dir === source) continue
    if (!existsSync(path.join(dir, 'superagent.db'))) continue
    try {
      const rows = execFileSync(
        'sqlite3',
        [path.join(dir, 'superagent.db'), "select count(*) from chat_integrations where provider='slack' and status='active';"],
        { encoding: 'utf8' },
      ).trim()
      if (Number(rows) > 0) found.push(`${label} is running with an active Slack integration (${dir})`)
    } catch {
      /* unreadable db — not evidence of a conflict */
    }
  }
  return found
}

if (import.meta.url === `file://${process.argv[1]}`) {
  preflight()
    .then((r) => {
      console.log(r.ok ? '\npreflight PASSED' : '\npreflight FAILED')
      process.exit(r.ok ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\npreflight ERROR: ${err.message}`)
      process.exit(1)
    })
}
