# One-time legacy data migrations

Use this directory to convert **existing legacy data** into its current format,
such as importing agent metadata from files or moving old provider settings into
SQLite. These migrations are upgrade steps, not application initialization.

## Keep bootstrapping separate

Fresh installations must work without running any migration in this directory.
Put provider provisioning, initial defaults, onboarding, and other required setup
in the normal startup or configuration lifecycle. Recurring reconciliation also
belongs in application code.

For example, Platform startup/login ensures its managed provider and initial
model defaults exist. The legacy provider migration only imports the previous
settings format; production setup must not depend on that import. The
[bootstrap tests](../../llm-provider/connection-bootstrap.test.ts) exercise setup
with schema migrations applied and no data migrations run.

## Execution and implementation

The [runner](index.ts) runs registered migrations after schema migrations and
before publishing the database handle. It records successful completion in the
`data_migrations` table, once per database. New databases also run registered
migrations; when there is no legacy data, there should be nothing to convert.
That execution behavior is not a contract for bootstrapping new installations.

- Assign a unique, increasing numeric ID and register the migration in
  `DATA_MIGRATIONS`. Never renumber migrations or reuse an ID, including a retired
  migration's ID.
- Make `run()` idempotent. Completion is recorded after it returns, so a failure
  or crash can cause a retry over partially migrated data.
- Use the supplied database handle and await database operations; the global
  database handle is not available yet.
- Preserve existing migrated records and user edits on retries. Test the legacy
  conversion, empty input, and interrupted/repeated execution.

## Retiring migrations

Unlike the database schema migrations in [`../migrations`](../migrations),
**older data migrations may be removed in the future** once their legacy upgrade
path is no longer supported. Treat these as temporary compatibility code.

When retiring one, remove its implementation and registration while retaining
existing ledger entries and reserving its ID. Check that fresh setup and runtime
behavior remain independent of it. Any initialization needed by new deployments
must remain in application code after the migration is gone.
