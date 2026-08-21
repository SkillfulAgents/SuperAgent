/**
 * Build the isolated data dir the suite boots against.
 *
 * The source install is never written to. What the seed produces is a data dir
 * that holds exactly one agent and exactly one chat integration — the Slack
 * one, retargeted at the seeded agent — so that:
 *
 *   - the container name is derived from a slug the source install does not
 *     use, and a run cannot collide with (or tear down) the agent the user is
 *     working in,
 *   - no scheduled task, trigger, or second integration wakes anything the
 *     suite did not ask for,
 *   - each run starts from an empty conversation history, so "the agent
 *     replied" is never satisfied by a previous run's transcript.
 *
 * The Slack tokens are carried over verbatim — there is only one Slack app, and
 * the whole point is to drive it for real.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { readSlackIntegration, exec, query } from './data-dir.mjs'

export const DEFAULT_TARGET_DIR = path.join(os.homedir(), 'Downloads', 'slack-chat-validation')

/**
 * A slug no real install uses, so `superagent-<slug>` can never be the
 * container of an agent someone is working in.
 */
export const VALIDATION_AGENT_SLUG = 'slack-validation-agent'

const AGENT_CLAUDE_MD = `---
name: Slack Validation Agent
createdAt: "2026-01-01T00:00:00.000Z"
description: Drives the Slack chat-integration validation suite
---

# Agent Instructions

You are the target of an automated validation suite for the Slack chat
integration. Follow instructions literally and completely.

## Rules

- When asked to call a specific tool, call exactly that tool, once, with the
  arguments described — do not substitute a different tool and do not ask for
  confirmation first.
- If a named tool is not already loaded, use ToolSearch to load it by name and
  then call it. Never give up on a named tool because it was not in the initial
  list, and never report success without having called it.
- When asked to reply with an exact marker (e.g. \`DONE: <something>\`), reply
  with that marker on its own line and nothing else around it.
- Never invent a value for something you were asked to request from the user.
  Requesting it through the proper tool IS the task.
- Keep replies short. Do not summarise these instructions back.
`

/**
 * Tables whose rows would make the seeded install do something on its own, or
 * would carry another install's history into a run. Emptied rather than
 * dropped so the schema (and drizzle's migration bookkeeping) stays intact.
 */
const TABLES_TO_EMPTY = [
  'chat_integration_sessions',
  'chat_integration_access',
  'scheduled_tasks',
  'webhook_triggers',
  'notifications',
  'agent_acl',
  'agent_connected_accounts',
  'agent_remote_mcps',
  'remote_mcp_servers',
  'x_agent_policies',
  'api_scope_policies',
  'mcp_tool_policies',
  'proxy_audit_log',
  'mcp_audit_log',
  'audit_log',
  'message_author',
  'proxy_tokens',
  'token_exchange_jti',
  'session',
]

export function seed({ source, target = DEFAULT_TARGET_DIR, log = () => {} } = {}) {
  const integration = readSlackIntegration(source)

  // A previous host that is still shutting down can write into the dir mid-rm
  // (Electron drops a crash marker on exit), which surfaces as ENOTEMPTY.
  // Retry rather than fail the run on a teardown race.
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      break
    } catch (err) {
      if (attempt >= 5) {
        throw new Error(
          `Could not clear ${target} (${err.message}). Something is still writing to it — ` +
            `check for a surviving Electron or vite process from an earlier run.`,
        )
      }
      execFileSync('sleep', ['2'])
    }
  }
  mkdirSync(path.join(target, 'agents', VALIDATION_AGENT_SLUG, 'workspace'), { recursive: true })
  log(`seeded data dir: ${target}`)

  // settings.json verbatim: the LLM key, container runner, and account
  // providers all have to match the install the integration came from.
  copyFileSync(path.join(source, 'settings.json'), path.join(target, 'settings.json'))
  for (const optional of ['tenant-id', 'host-container-tokens.json']) {
    const from = path.join(source, optional)
    if (existsSync(from)) copyFileSync(from, path.join(target, optional))
  }

  writeFileSync(
    path.join(target, 'agents', VALIDATION_AGENT_SLUG, 'workspace', 'CLAUDE.md'),
    AGENT_CLAUDE_MD,
  )

  copyFileSync(path.join(source, 'superagent.db'), path.join(target, 'superagent.db'))
  // WAL/SHM siblings would otherwise replay the source's uncommitted tail over
  // the copy. Checkpointing the copy on first open is enough — we simply don't
  // carry them across.
  for (const sidecar of ['superagent.db-wal', 'superagent.db-shm']) {
    rmSync(path.join(target, sidecar), { force: true })
  }

  const statements = [
    ...TABLES_TO_EMPTY.map((t) => `delete from ${t};`),
    `delete from chat_integrations where id <> '${integration.id}';`,
    `update chat_integrations set agent_slug = '${VALIDATION_AGENT_SLUG}', status = 'active' where id = '${integration.id}';`,
  ]
  exec(target, statements.join('\n'))

  const kept = query(target, 'select id, agent_slug, provider, status, show_tool_calls, require_approval from chat_integrations;')
  log(
    `integration ${kept[0].id} retargeted to ${kept[0].agent_slug} ` +
      `(showToolCalls=${kept[0].show_tool_calls}, requireApproval=${kept[0].require_approval})`,
  )

  return { target, integrationId: integration.id, agentSlug: VALIDATION_AGENT_SLUG, config: integration.config }
}

/** Container left over from an earlier run — removed so each run boots clean. */
export function removeValidationContainer(log = () => {}) {
  const name = `superagent-${VALIDATION_AGENT_SLUG}`
  try {
    const out = execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' }).trim()
    if (!out) return
    execFileSync('docker', ['rm', '-f', name], { encoding: 'utf8' })
    log(`removed stale container ${name}`)
  } catch (err) {
    log(`could not remove ${name}: ${err.message}`)
  }
}

