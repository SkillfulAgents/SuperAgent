/**
 * Reading a Superagent data directory from outside the app's module graph.
 *
 * The harness runs as plain Node (no vite aliases), so it cannot import
 * `@shared/...`. Everything here is a deliberate, minimal re-read of on-disk
 * state the app owns: settings.json and the SQLite file. Nothing is written
 * back to a source data dir — see seed.mjs for the isolated copy the harness
 * actually boots against.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_SOURCE_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Superagent-dev',
)

/**
 * The packaged install. Kept as a second place to look for the human Slack
 * connection: people connect their personal accounts in the app they actually
 * use, which is usually not the dev build that owns the bot.
 */
export const PACKAGED_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Superagent',
)

/** Run a query against a data dir's SQLite file, returning parsed JSON rows. */
export function query(dataDir, sql) {
  const dbPath = path.join(dataDir, 'superagent.db')
  if (!existsSync(dbPath)) throw new Error(`No superagent.db in ${dataDir}`)
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim()
  if (!out) return []
  try {
    return JSON.parse(out)
  } catch (err) {
    throw new Error(`sqlite3 returned non-JSON for "${sql}": ${err.message}`)
  }
}

/** Run a statement against a data dir's SQLite file (no result). */
export function exec(dataDir, sql) {
  execFileSync('sqlite3', [path.join(dataDir, 'superagent.db'), sql], { encoding: 'utf8' })
}

export function readSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`)
  }
}

/**
 * The Slack chat integration row plus its parsed config.
 *
 * The config holds the bot and app tokens. They are returned so the harness can
 * open real Slack connections with them and MUST NOT be logged — every printer
 * in this harness goes through redact().
 */
export function readSlackIntegration(dataDir) {
  const rows = query(
    dataDir,
    "select id, agent_slug, provider, name, show_tool_calls, require_approval, status, config from chat_integrations where provider = 'slack';",
  )
  if (rows.length === 0) throw new Error(`No Slack chat integration in ${dataDir}`)
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} Slack integrations in ${dataDir} — the harness needs exactly one to be unambiguous`,
    )
  }
  const row = rows[0]
  try {
    return { ...row, config: JSON.parse(row.config) }
  } catch (err) {
    throw new Error(`Slack integration ${row.id} has an unparseable config: ${err.message}`)
  }
}

/** Every Slack connected account, newest first — candidates for the human sender. */
export function readSlackConnectedAccounts(dataDir) {
  return query(
    dataDir,
    "select id, provider_connection_id, provider_name, status, display_name from connected_accounts where toolkit_slug = 'slack' order by created_at desc;",
  )
}

/** Redact a credential for logs: never print more than a recognisable stub. */
export function redact(secret) {
  if (!secret) return '<none>'
  const s = String(secret)
  return `${s.slice(0, 4)}…(${s.length} chars)`
}
