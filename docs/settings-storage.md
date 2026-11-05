# Settings and host records

App settings and the deployment's other small host records live in the app
database, in the `app_records` table: one JSON value per key, with a
revision. Every deployment uses this one path (desktop and single-tenant web
on better-sqlite3, CI on libsql, Cloudflare on D1), so a setting saved by one
process is what every other process of the deployment reads next.

| Key | What | Created by |
| -- | -- | -- |
| `settings` | `AppSettings`, as one object (shape and defaults unchanged; defaults are merged on read) | the first settings write |
| `tenant-id` | the deployment's analytics / error-reporting identity | `getTenantId()` on first use |
| `auth-secret` | Better Auth's secret when `BETTER_AUTH_SECRET` is unset; also the root of the S3 volume credential key | `getOrCreateAuthSecret()` on first use |
| `host-container-token:<agent>` | the per-agent token the host presents to the agent's container | `getOrCreateHostToken(agent)` on first use |
| `platform-client-instance-id` | this deployment's client id for platform device login | `getOrCreatePlatformClientInstanceId()` on first use |
| `browser-context:<provider>:<key>` | persistent Browserbase context ids of the host-browser providers | `getOrCreateMapping()` on first open |

Values are validated with Zod on every read and write
(`app-records/record-schemas.ts`, `config/settings-schema.ts`).

## Reading

`await getSettings()` reads the database every time. There is no process
cache, and nothing to invalidate. Read once at the start of an operation (a
request, a job, a session start, a message) and pass the value or the fields
you need to the helpers that operation calls, rather than having every helper
read again. Never keep settings, or anything built from them, in module state
across operations: another process may change them, and nothing tells this one.
A long-lived object built from settings (the Better Auth instance, a container
runtime's client, the account providers) re-checks the settings it was built
from when it is used, and rebuilds when they changed. Two deliberate
exceptions, because a running container cannot change them: a runtime keeps
the client of a container that is starting, running or stopping (a runner
change applies at the next start), and a client keeps the host token it read
(insert-if-absent, so it never changes for an agent).

Most helpers that read settings have a pure `…From(settings)` variant or an
optional `settings` parameter (`effectiveModelsFrom`, `activeLlmProviderFrom`,
`provider.apiKeyStatusFrom`, `resolveSelectionHierarchyFrom`,
`sessionConnectionRuntime(selected, agent, settings)`, `platformAccessTokenFrom`,
`activeWebProviderFrom`, `composioAuthFrom`, `resolveSessionDefaults`,
`getConfiguredLlmClientAndModel`, …): an operation reads once and passes the
value down. A batch (a listing, a sweep, a page fetch, a fan-out) must not read
once per item; tests count reads with the in-memory store (`store.calls.read`)
and assert the count does not grow with the batch. Within one request, the
platform attribution is resolved once and shared
(`platform-attribution/request-context.ts`); work the request leaves running
after it ends resolves afresh, and a platform-auth write in the request drops it.

Invalid stored settings read as the defaults (reported, never written back).
A database error is not invalid data: it propagates.

## Writing

There are no interactive transactions on the drivers the app targets, so a
write is a compare-and-set on the revision the writer read:

```ts
await mutateSettings((s) => {
  s.app = { ...s.app, theme: 'dark' }
})
```

When another writer committed in between, `mutateSettings` reads again and
runs the mutator again on the newer settings, so **the mutator may run more
than once**. It must be synchronous and change only the draft it is given: no
I/O, no events, no appending to outer arrays it does not reset. Do side effects
after the call resolves, with the settings it returns. Return `false` to write
nothing; `updateSettings()` gives the settings read (`before`) as well.

Stored settings that cannot be read abort the write instead of being replaced
with defaults.

## Identities created once

`getOrCreateRecord()` reads the record, and when it is absent inserts a new
value with insert-if-absent and returns whatever the database then holds. Two
processes starting on an empty database therefore agree on one tenant id, one
auth secret, one token per agent; a process starting on a populated database
(a Worker cold start, an app restart) reads the existing records and never
makes new ones. A database error or an invalid stored value throws: neither is
evidence that the record is absent.

## Startup

Each entry point opens the database and installs the store before anything
reads a record:

```ts
installAppRecordStore(dbAppRecordStore(await openDatabase()))
```

The entry points are `src/web/server.ts`, `src/main/index.ts`, the Vite dev
server's `server-lifecycle` plugin (`vite.config.ts`, which re-installs when
an edit re-instantiates the module), and the perf harnesses.
Reading before that throws. The store is the deployment's for the life of the
process; it is never swapped per request. Error reporting starts before the
database (so a failed boot is reported) and gets the tenant id afterwards
(`attachErrorReportingIdentity()`); analytics drops events whose consent it
cannot read.

In unit tests every test starts with a fresh, empty in-memory store: the
vitest setup file `app-records/testing/vitest-setup.ts` installs one before
each test, so a test that only needs settings to work installs nothing. From
`app-records/testing/memory-record-store.ts`:
`installTestAppRecordStore(store?)` in a test's own `beforeEach` gets hold of
the store (to seed or count reads) or installs another one (a database store
on `createTestDatabase()`; `createTestDatabase({ file })` opens a shared file
so two handles stand in for two processes); `keepAppRecordStoreAcrossTests()`
in `beforeAll` keeps one store for a file that seeds once; a test of the
no-store case calls `uninstallAppRecordStore()`.

## Upgrading from files

Data migration 9 (`db/data-migrations/0009-import-host-records.ts`) imports
the old files of the data dir (`settings.json`, `tenant-id`, `.auth-secret`,
`host-container-tokens.json`, `.platform-auth/client-instance-id`,
`browserbase-contexts.json`, `platform-browserbase-contexts.json`) with
insert-if-absent, so a retry never overwrites a value imported or edited since.
The manifest, including what deliberately stays a file (`.vault-key`, the
crash marker, workspaces, blobs, caches, machine-local runtime state), is in
`app-records/legacy-host-files.ts`. A file that cannot be parsed is reported
and skipped; the files are left on disk and nothing reads them afterwards.
Migrations that read settings (2 and 3) start from `legacyRecordStore(db)`,
which runs the same import first, so an install that skips versions migrates
its real settings.

## Not here

- `.vault-key` and other encryption keys: KeyManager (SUP-1509).
- The S3 volume credential key derives from the auth secret. When
  `BETTER_AUTH_SECRET` is unset, that secret is now an app record in the same
  database as the sealed credentials; giving the credentials their own
  KeyManager key is SUP-1532.
