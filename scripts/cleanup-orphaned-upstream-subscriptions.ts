/**
 * One-time cleanup of orphaned upstream webhook subscriptions (SUP-765).
 *
 * Pre-SUP-765, a cross-member teardown 404ed silently: the local row went
 * cancelled while the upstream (Composio subscription / platform webhook
 * endpoint) stayed live. This tears down every terminal row (cancelled/failed)
 * that still has an upstream id, no `upstream_deleted_at`, and no active/paused
 * sibling — as the recorded minting member (creator/owner chain for pre-column
 * rows), through the same service path the app's poll-loop reconcile uses.
 * A 404 counts as gone and sets the marker.
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
 *     npx tsx scripts/cleanup-orphaned-upstream-subscriptions.ts [--dry-run]
 *
 * The DB schema must already be at this checkout's latest migration; the
 * script checks that read-only first and exits if not, so it never migrates a
 * live DB. `--dry-run` lists candidates and makes no network calls or writes.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { getDatabasePath } from '../src/shared/lib/config/data-dir'
import { installPlatformFetchInterceptor } from '../src/shared/lib/platform-attribution'
import { getPlatformAccessToken } from '../src/shared/lib/services/platform-auth-service'
import {
  listOrphanedUpstreamTriggers,
  deleteOrphanedUpstreamSubscription,
} from '../src/shared/lib/services/webhook-trigger-service'

const dryRun = process.argv.includes('--dry-run')
// Same resolution as db/index.ts (run from the repo root).
const JOURNAL_PATH = path.join(process.cwd(), 'src/shared/lib/db/migrations/meta/_journal.json')

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
// touch, so make sure there are none before importing anything that uses it.
function assertSchemaCurrent(dbPath: string): void {
  let expected: { when: number; tag: string }
  try {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')) as {
      entries: Array<{ when: number; tag: string }>
    }
    expected = journal.entries[journal.entries.length - 1]
  } catch (error) {
    fail(`Could not read ${JOURNAL_PATH} (run from the repo root): ${String(error)}`)
  }
  if (!fs.existsSync(dbPath)) fail(`No database at ${dbPath}.`)

  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: number | string } | undefined
    const applied = Number(row?.created_at ?? 0)
    if (applied < expected.when) {
      fail(
        `Schema at ${dbPath} is behind this checkout (latest applied ${applied}, need ${expected.when} ${expected.tag}). ` +
          'Upgrade the deployment first; this script never migrates.',
      )
    }
    if (applied > expected.when) {
      fail(`Schema at ${dbPath} is newer than this checkout (${applied} > ${expected.when}). Use a matching checkout.`)
    }
  } catch (error) {
    fail(`Could not read migration state from ${dbPath}: ${String(error)}`)
  } finally {
    sqlite.close()
  }
}

async function main(): Promise<void> {
  requireEnv('SUPERAGENT_DATA_DIR')
  requireEnv('PLATFORM_PROXY_URL')
  assertSchemaCurrent(getDatabasePath())
  if (!getPlatformAccessToken()) {
    fail('No platform access token: none in settings.json under SUPERAGENT_DATA_DIR, and AUTH_MODE/PLATFORM_TOKEN unset.')
  }

  // Attribution only reaches the wire through the interceptor; without it every
  // call goes out as the bare org token and the proxy 404s each delete.
  installPlatformFetchInterceptor()

  const candidates = listOrphanedUpstreamTriggers()
  console.log(`${candidates.length} orphan candidate(s)${dryRun ? ' (dry run)' : ''}`)

  let deleted = 0
  for (const trigger of candidates) {
    const minted = trigger.mintedByMemberId ? `minted by ${trigger.mintedByMemberId}` : 'pre-column row'
    const label = `${trigger.kind} ${trigger.composioTriggerId} (trigger ${trigger.id}, agent ${trigger.agentSlug}, ${minted})`
    if (dryRun) {
      console.log(`DRY-RUN would tear down ${label}`)
      continue
    }
    try {
      if (await deleteOrphanedUpstreamSubscription(trigger)) {
        deleted++
        console.log(`DONE ${label}`)
      } else {
        console.log(`SKIP ${label}: upstream unreachable or re-subscribed since scan`)
      }
    } catch (error) {
      console.warn(`FAILED ${label}:`, error)
    }
  }
  console.log(dryRun ? 'Dry run complete.' : `Done. Tore down ${deleted} upstream subscription(s).`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
