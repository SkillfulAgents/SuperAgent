/**
 * One-time cleanup of orphaned upstream webhook subscriptions (SUP-765).
 *
 * Pre-SUP-765, a cross-member teardown 404ed silently: the local row went
 * cancelled while the upstream (Composio subscription / platform webhook
 * endpoint) stayed live. Migration 0040 backfills `upstream_deleted_at` on
 * every pre-existing terminal row, so the app's poll-loop reconcile never
 * touches legacy rows; this script is how they get cleaned.
 *
 * It never trusts the marker or a 404 (the proxy 404s a cross-member DELETE
 * exactly like a missing subscription). Instead it LISTS live upstreams under
 * every platform member this host knows and deletes only what upstream still
 * reports live for a terminal local row with no active/paused sibling, acting
 * as the member the listing came from.
 *
 * Required env (the script refuses to run without both):
 *   SUPERAGENT_DATA_DIR  the deployment's data dir: settings.json supplies the
 *                        platform token + Composio mode; superagent.db lives
 *                        here unless SUPERAGENT_DB_PATH overrides it.
 *   PLATFORM_PROXY_URL   platform proxy base URL (the build-time global is
 *                        undefined under tsx).
 * Cloud deployments keep the token in env instead: pass the same
 * AUTH_MODE=true PLATFORM_TOKEN=... the host-app runs with.
 *
 *   SUPERAGENT_DATA_DIR=/srv/superagent PLATFORM_PROXY_URL=https://proxy.example.com \
 *     npx tsx scripts/cleanup-orphaned-upstream-subscriptions.ts --dry-run
 *     npx tsx scripts/cleanup-orphaned-upstream-subscriptions.ts --upstream-id ti_123
 *
 * The DB schema must already be at this checkout's latest migration; the
 * script checks that read-only first and exits if not, so it never migrates a
 * live DB. `--dry-run` lists candidates without network calls or writes.
 * Mutation requires explicit IDs because another host may share a live ID.
 */
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { readMigrationFiles } from 'drizzle-orm/migrator'

import { getDatabasePath } from '../src/shared/lib/config/data-dir'
import { getMigrationsFolder } from '../src/shared/lib/db'
import { isPlatformComposioActive } from '../src/shared/lib/composio/client'
import { deleteComposioTrigger, listActiveComposioTriggers } from '../src/shared/lib/composio/triggers'
import {
  attribution,
  installPlatformFetchInterceptorIfOrgToken,
  runWithAttribution,
} from '../src/shared/lib/platform-attribution'
import { getPlatformAccessToken, getStoredPlatformMemberId } from '../src/shared/lib/services/platform-auth-service'
import {
  disablePlatformWebhookEndpoint,
  listPlatformWebhookEndpoints,
} from '../src/shared/lib/services/webhook-endpoints-client'
import {
  countActiveTriggersForComposioId,
  listPlatformMemberIds,
  listTerminalUpstreamTriggers,
  markUpstreamDeleted,
  resolveTeardownMembers,
  type WebhookTrigger,
} from '../src/shared/lib/services/webhook-trigger-service'

const dryRun = process.argv.includes('--dry-run')

function requestedUpstreamIds(): Set<string> {
  const ids = new Set<string>()
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--upstream-id' && process.argv[i + 1]) ids.add(process.argv[++i])
    else if (process.argv[i].startsWith('--upstream-id=')) ids.add(process.argv[i].slice(14))
  }
  return ids
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`${name} is not set; refusing to run against an ambiguous deployment.`)
  return value
}

// Read-only pre-flight: the shared db module runs pending migrations on first
// touch, so make sure there are none before anything touches it. Compares the
// same value drizzle's migrate() does (folderMillis vs created_at).
function assertSchemaCurrent(dbPath: string): void {
  const migrations = readMigrationFiles({ migrationsFolder: getMigrationsFolder() })
  const expected = migrations[migrations.length - 1]
  if (!expected) fail(`No migrations found under ${getMigrationsFolder()} (run from the repo root).`)
  if (!fs.existsSync(dbPath)) fail(`No database at ${dbPath}.`)

  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: number | string } | undefined
    const applied = Number(row?.created_at ?? 0)
    if (applied < expected.folderMillis) {
      fail(
        `Schema at ${dbPath} is behind this checkout (latest applied ${applied}, need ${expected.folderMillis}). ` +
          'Upgrade the deployment first; this script never migrates.',
      )
    }
    if (applied > expected.folderMillis) {
      fail(`Schema at ${dbPath} is newer than this checkout (${applied} > ${expected.folderMillis}). Use a matching checkout.`)
    }
  } catch (error) {
    fail(`Could not read migration state from ${dbPath}: ${String(error)}`)
  } finally {
    sqlite.close()
  }
}

// Every member that might have minted one of the candidates: whatever the
// service would guess per row, plus every platform member with a local
// authAccount row. In opaque-key mode the proxy ignores the member, so one
// pass under the placeholder covers everything.
function collectMemberIds(candidates: WebhookTrigger[]): string[] {
  if (!attribution.requiresActingMember()) return [getStoredPlatformMemberId() ?? 'local']
  const ids = new Set<string>(listPlatformMemberIds())
  for (const trigger of candidates) {
    for (const memberId of resolveTeardownMembers(trigger).memberIds) ids.add(memberId)
  }
  return [...ids]
}

function describe(trigger: WebhookTrigger): string {
  const minted = trigger.mintedByMemberId ? `minted by ${trigger.mintedByMemberId}` : 'pre-column row'
  return `${trigger.kind} ${trigger.composioTriggerId} (trigger ${trigger.id}, agent ${trigger.agentSlug}, ${trigger.status}, ${minted})`
}

async function listLiveUpstreamIds(memberId: string, kinds: Set<WebhookTrigger['kind']>): Promise<Set<string>> {
  const live = new Set<string>()
  if (kinds.has('composio')) {
    for (const t of await listActiveComposioTriggers()) if (!t.isDisabled) live.add(t.id)
  }
  if (kinds.has('custom')) {
    for (const e of await listPlatformWebhookEndpoints(memberId)) if (e.status === 'active') live.add(e.id)
  }
  return live
}

async function main(): Promise<void> {
  requireEnv('SUPERAGENT_DATA_DIR')
  requireEnv('PLATFORM_PROXY_URL')
  assertSchemaCurrent(getDatabasePath())
  if (!getPlatformAccessToken()) {
    fail('No platform access token: none in settings.json under SUPERAGENT_DATA_DIR, and AUTH_MODE/PLATFORM_TOKEN unset.')
  }

  // Attribution only reaches the wire through the interceptor; without it every
  // org-JWT call goes out as the bare token and the proxy rejects it.
  installPlatformFetchInterceptorIfOrgToken()

  const reachable = new Set<WebhookTrigger['kind']>(['custom'])
  if (isPlatformComposioActive()) reachable.add('composio')
  const requested = requestedUpstreamIds()
  if (!dryRun && requested.size === 0) {
    fail('Mutation requires at least one explicit --upstream-id; IDs may be live on another host.')
  }
  const candidates = listTerminalUpstreamTriggers().filter(
    (trigger) =>
      reachable.has(trigger.kind) &&
      (dryRun || requested.has(trigger.composioTriggerId!)),
  )
  if (!dryRun) {
    const found = new Set(candidates.map((trigger) => trigger.composioTriggerId!))
    const missing = [...requested].filter((id) => !found.has(id))
    if (missing.length > 0) fail(`Requested IDs are not eligible local terminal rows: ${missing.join(', ')}`)
  }
  const byUpstreamId = new Map(candidates.map((t) => [t.composioTriggerId!, t]))
  const memberIds = collectMemberIds(candidates)

  console.log(`${candidates.length} terminal row(s) with an upstream id; checking under ${memberIds.length} member(s)${dryRun ? ' (dry run)' : ''}`)
  for (const trigger of candidates) console.log(`  candidate ${describe(trigger)}`)
  if (dryRun) {
    console.log(`Dry run complete. Members that would be listed: ${memberIds.join(', ')}`)
    return
  }

  let deleted = 0
  const confirmed = new Set<string>()
  for (const memberId of memberIds) {
    const auth = attribution.requiresActingMember() ? attribution.fromMemberId(memberId) : null
    try {
      await runWithAttribution(auth, async () => {
        const live = await listLiveUpstreamIds(memberId, reachable)
        for (const [upstreamId, trigger] of byUpstreamId) {
          if (!live.has(upstreamId) || confirmed.has(upstreamId)) continue
          // Re-check immediately before the delete: a same-slug re-enable gets
          // the same upstream id back and would lose its subscription.
          if ((await countActiveTriggersForComposioId(upstreamId)) > 0) {
            console.log(`SKIP ${describe(trigger)}: re-subscribed locally since scan`)
            continue
          }
          try {
            if (trigger.kind === 'custom') await disablePlatformWebhookEndpoint(memberId, upstreamId)
            else await deleteComposioTrigger(upstreamId)
            await markUpstreamDeleted(upstreamId)
            confirmed.add(upstreamId)
            deleted++
            console.log(`DONE ${describe(trigger)} as ${memberId}`)
          } catch (error) {
            console.warn(`FAILED ${describe(trigger)} as ${memberId}:`, error)
          }
        }
      })
    } catch (error) {
      console.warn(`Listing live upstreams as ${memberId} failed (skipping this member):`, error)
    }
  }

  const unseen = [...byUpstreamId.values()].filter((t) => !confirmed.has(t.composioTriggerId!))
  console.log(`Done. Tore down ${deleted} upstream subscription(s).`)
  if (unseen.length > 0) {
    console.log(`${unseen.length} candidate(s) were not live under any listed member (already gone, or minted by a member this host has no record of):`)
    for (const trigger of unseen) console.log(`  ${describe(trigger)}`)
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
