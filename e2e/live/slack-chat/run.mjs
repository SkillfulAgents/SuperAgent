#!/usr/bin/env node
/**
 * Live end-to-end validation of the Slack chat integration.
 *
 * Nothing on the path is mocked. A real second Slack identity posts into a real
 * conversation, a real app instance (booted against an isolated data dir)
 * receives it over Socket Mode, a real container runs the turn, and the
 * assertions read what actually landed back in Slack — Block Kit payloads
 * included.
 *
 * The suite exists because the chat integration's own tests are contract tests:
 * they pin the shape of events the connectors are handed, not the fact that the
 * host still hands them those events. A refactor can keep every contract test
 * green and still stop delivering cards.
 *
 * Run:
 *   node e2e/live/slack-chat/run.mjs                      # web host, linked notices
 *   node e2e/live/slack-chat/run.mjs --host=electron      # desktop host (superagent-dev:// links)
 *   node e2e/live/slack-chat/run.mjs --no-public-url      # cloud host with no HOST_PUBLIC_URL
 *   node e2e/live/slack-chat/run.mjs --only=unsupported   # a tag or comma-separated ids
 *   node e2e/live/slack-chat/run.mjs --keep-app           # leave the app running for poking
 *
 * See .claude/skills/slack-chat-validation/SKILL.md for prerequisites and for
 * what each check protects.
 */

import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'

import { DEFAULT_SOURCE_DATA_DIR, PACKAGED_DATA_DIR, readSlackIntegration } from './lib/data-dir.mjs'
import { resolveBot, resolveSenderAcross } from './lib/slack.mjs'
import { resolveSurface } from './lib/surface.mjs'
import { seed, removeValidationContainer, DEFAULT_TARGET_DIR, VALIDATION_AGENT_SLUG } from './lib/seed.mjs'
import { startApp, freePort, containerPortRangeConflicts } from './lib/app.mjs'
import { Conversation } from './lib/conversation.mjs'
import { CHECKS, OPT_IN_CHECKS } from './lib/checks.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.length ? v.join('=') : true]
  }),
)

const HOST = args.host === 'electron' ? 'electron' : 'web'
const SOURCE = args.source || process.env.SLACK_VALIDATION_SOURCE_DIR || DEFAULT_SOURCE_DATA_DIR
const SENDER_OVERRIDE = args['sender-source'] || process.env.SLACK_VALIDATION_SENDER_DIR
const TARGET = args.target || DEFAULT_TARGET_DIR
const RUN_DIR = path.join(os.tmpdir(), `slack-chat-validation-${Date.now()}`)

// The cloud host links to HOST_PUBLIC_URL. --no-public-url exercises the row of
// the notice matrix where it is unset and the link must be omitted entirely
// rather than degrading to a broken URL.
const PUBLIC_URL = args['no-public-url'] ? '' : args['public-url'] || 'https://validation.example.test'

const log = (msg) => console.log(`[slack-validation] ${msg}`)

function selected() {
  const all = [...CHECKS, ...(args['with-computer-use'] ? OPT_IN_CHECKS : [])]
  if (!args.only) return all
  const wanted = String(args.only).split(',').map((s) => s.trim()).filter(Boolean)
  const picked = all.filter((c) => wanted.includes(c.id) || c.tags?.some((t) => wanted.includes(t)))
  if (picked.length === 0) throw new Error(`--only=${args.only} matched no checks`)
  return picked
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true })
  const checks = selected()
  log(`${checks.length} checks, host=${HOST}, run dir ${RUN_DIR}`)

  // ── Slack identities and the conversation ──────────────────────────
  const sourceIntegration = readSlackIntegration(SOURCE)
  const botAuth = await resolveBot(sourceIntegration.config.botToken)
  log(`integration bot: ${botAuth.user} (${botAuth.user_id}) in ${botAuth.team}`)
  const sender = await resolveSenderAcross(
    SENDER_OVERRIDE ? [SENDER_OVERRIDE] : [SOURCE, PACKAGED_DATA_DIR],
    botAuth,
    log,
  )
  const surface = await resolveSurface({
    sender,
    botToken: sourceIntegration.config.botToken,
    botAuth,
    preferred: args.channel || process.env.SLACK_VALIDATION_CHANNEL,
    log,
  })
  log(`conversation: ${surface.label} (${surface.channelId})`)

  // ── Isolated install ───────────────────────────────────────────────
  const seeded = seed({ source: SOURCE, target: TARGET, log })
  removeValidationContainer(log)

  // ── The app under test ─────────────────────────────────────────────
  const containerBasePort = Number(args['container-base-port'] ?? 5300)
  const conflicts = await containerPortRangeConflicts(containerBasePort)
  if (conflicts.length > 0) {
    throw new Error(
      `Container publish range ${containerBasePort}+ is not free (busy: ${conflicts.join(', ')}). ` +
        `A loopback listener there — typically a packaged install's Lima port-forward — shadows ` +
        `Docker's publish, so every host→container call lands in the other install's container and ` +
        `returns 401. Pass --container-base-port=<free base>.`,
    )
  }
  const port = await freePort(Number(args.port) || undefined)
  const app = await startApp({
    host: HOST,
    dataDir: seeded.target,
    port,
    containerBasePort,
    hostPublicUrl: PUBLIC_URL,
    repoRoot: REPO_ROOT,
    logFile: path.join(RUN_DIR, `app-${HOST}.log`),
    integrationId: seeded.integrationId,
    log,
  })

  const hostShape =
    HOST === 'electron'
      ? { isDesktop: true, appLinkBase: `superagent-dev://agent/${encodeURIComponent(VALIDATION_AGENT_SLUG)}` }
      : {
          isDesktop: false,
          appLinkBase: PUBLIC_URL
            ? `${PUBLIC_URL.replace(/\/+$/, '')}/agents/${encodeURIComponent(VALIDATION_AGENT_SLUG)}`
            : null,
        }
  log(`expected app link base: ${hostShape.appLinkBase ?? '(none — link omitted)'}`)

  const conv = new Conversation({
    botToken: sourceIntegration.config.botToken,
    sender,
    channelId: surface.channelId,
    botUserId: botAuth.user_id,
    log: (m) => log(m),
  })
  await conv.resetWatermark()

  if (args['boot-only']) {
    // Everything except spending container turns: proves the seed, the host
    // boot, the Socket Mode connection, and both Slack identities line up.
    log(`boot-only: app on ${app.base}, data dir ${seeded.target}`)
    await app.stop()
    return true
  }

  const ctx = {
    conv,
    api: app.api,
    agentSlug: seeded.agentSlug,
    integrationId: seeded.integrationId,
    hostShape,
    host: HOST,
  }

  // ── Warm up ────────────────────────────────────────────────────────
  // The first turn pays for the container's cold start, which can exceed a
  // check's own timeout. When inbound-turn is in the selection it absorbs that
  // itself; otherwise a --only run would charge the cold start to whichever
  // check happened to go first and fail it for the wrong reason.
  if (!checks.some((c) => c.id === 'inbound-turn')) {
    const tag = Math.random().toString(36).slice(2, 8).toUpperCase()
    log('warming up the container with one throwaway turn…')
    await conv.say(`Reply with exactly: WARM ${tag}`)
    await conv.awaitBot(`WARM ${tag}`, (_m, text) => text.includes(`WARM ${tag}`), 480_000)
    log('warm')
  }

  // ── Run ────────────────────────────────────────────────────────────
  const results = []
  // One retry by default. Every check drives a live model, and a model that
  // wanders off (searching for a tool instead of calling it, answering in prose)
  // is not the product being broken. A real regression fails both attempts, so
  // retrying costs a turn and buys a suite that is worth believing.
  const runCleanup = async (check) => {
    if (!check.cleanup) return
    try {
      await check.cleanup(ctx)
    } catch (err) {
      console.log(`  (cleanup for ${check.id} failed: ${err.message})`)
    }
  }

  for (const check of checks) {
    const started = Date.now()
    const attempts = args['no-retry'] ? 1 : (check.retries ?? 1) + 1
    process.stdout.write(`\n▸ ${check.id} — ${check.title}\n`)
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const detail = await check.run(ctx)
        const suffix = attempt > 1 ? ` (attempt ${attempt})` : ''
        results.push({ id: check.id, ok: true, detail: (detail ?? '') + suffix, ms: Date.now() - started })
        console.log(`  PASS (${Math.round((Date.now() - started) / 1000)}s)${detail ? ` — ${detail}` : ''}${suffix}`)
        lastError = null
        break
      } catch (err) {
        lastError = err
        if (attempt < attempts) {
          console.log(`  attempt ${attempt} failed, retrying — ${err.message.split('\n')[0]}`)
          await runCleanup(check)
          await conv.drain()
        }
      }
    }
    if (lastError) {
      results.push({ id: check.id, ok: false, detail: lastError.message, ms: Date.now() - started })
      console.log(`  FAIL (${Math.round((Date.now() - started) / 1000)}s) — ${lastError.message}`)
    }
    await runCleanup(check)
  }

  // ── Report ─────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${'═'.repeat(70)}`)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? ` — ${r.detail}` : ''}`)
  console.log(`${'═'.repeat(70)}\n${passed}/${results.length} passed — host=${HOST}, ${surface.label}`)

  const reportPath = path.join(RUN_DIR, 'report.json')
  writeFileSync(
    reportPath,
    JSON.stringify({ host: HOST, surface: surface.label, hostShape, results }, null, 2),
  )
  console.log(`report: ${reportPath}\napp log: ${app.logFile}`)

  if (args['keep-app']) {
    console.log(`\napp left running on ${app.base} (data dir ${seeded.target}) — ctrl-c to stop`)
    await new Promise(() => {})
  }
  await app.stop()
  return passed === results.length
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(`\n[slack-validation] ERROR: ${err.stack || err.message}`)
    process.exit(1)
  })
