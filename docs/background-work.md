# Background work

Scheduled work and the lifecycle of the app's background services go through two small abstractions, so the domain code stays the same when the backend changes. The code is in `src/shared/lib/background-work/`; the contract is `task.ts`.

- A **Task** is one kind of work: a stable type, a payload schema, and `execute()`. One class handles every instance of the work, which payloads tell apart.
- The **TaskManager** runs Tasks at times and on intervals. It owns registration, scheduling, process-local overlap protection, retries and cancellation.
- A **Service** groups domain behaviour: its Task definitions, plus start and stop hooks for the resources it holds. A Task on its own needs no Service.
- The **ServiceHost** is the registry of Services: phases, enablement, startup errors and teardown.

One-shot bootstrap stays in `startup.ts`. AppState stays shared state and live events ([app-state.md](app-state.md)), and agent-owned behaviour stays with the Actor.

## The local backend keeps nothing

`LocalTaskManager` holds its handlers, jobs, running guards and retry state in memory, on ordinary timers. It has no database and no restart recovery. When the process exits, everything pending is gone:

- Services register again on startup, and get fresh timers.
- Retry counts and backoff start over.
- A domain with its own records rebuilds its wakeups from them, as ordinary startup.

The reason for the abstraction is the replaceable backend, not durability on desktop. A later `CFTaskManager` can store serializable task references and use Durable Object alarms; that persistence and coordination are that backend's work. Do not add a task table, an outbox, leases or stored retry state to the local manager.

Awaiting `at()` on the local manager means the work is registered in this process, not that it is durably committed.

## Initialization

Each entry point picks the backend and installs it, after the database, AppState and key custody, and before it serves anything, because a request can schedule work as soon as the API is bound:

```ts
await initializeBackgroundWork(new LocalTaskManager())
```

The entry points are Electron main, `src/web/server.ts`, the Vite dev server's `server-lifecycle` plugin and `perf/harness.ts`. Another backend installs the same way, with its own manager. Only an entry point names a backend, so the package's index does not export `LocalTaskManager`: it comes from `background-work/local-task-manager`. Importing these modules starts no timer and does no I/O. `taskManager()` and `serviceHost()` before initialization throw.

Right after it installs, an entry point that runs the app's services (all of them but the perf harness, which boots only the API) calls `registerBackgroundWork()` from `startup.ts`. It registers every service and its Tasks on whatever is installed, and starts nothing. It picks no backend, and throws if nothing is installed. The dev server repeats it for each request.

A shutdown can come before the install, as the entry point is still on its way there. `stopBackgroundWork()` remembers it, and what the entry point goes on to install comes up stopped. Nothing has started by then, so no service has anything to release.

Call `taskManager()` and `serviceHost()` each time you use them. The instances are held on `globalThis`, so another copy of the module sees them too: after a test's `vi.resetModules()`, or after Vite re-instantiates the module following an edit.

Dispatch is on from the moment the entry point installs it. Services start after the bind, from `afterBindInitialize()`, as they always did: `eager` services on the path boot waits for, `background` services off it.

The shared test setup (`src/renderer/test/setup.ts`) installs a fresh manager and host before every node-environment test, with nothing registered and dispatch on. A test registers the Tasks it uses.

## Writing a Task

```ts
const payloadSchema = z.object({ scheduleId: z.string() })

class ReminderTask extends Task<z.infer<typeof payloadSchema>> {
  readonly type = 'reminders.send'
  readonly payloadSchema = payloadSchema

  constructor(private readonly reminders: Reminders) { super() }

  async execute({ scheduleId }, ctx): Promise<TaskResult<Payload>> {
    await this.reminders.sendOnce(scheduleId, ctx.signal)
    return { kind: 'done' }
  }
}
```

- **Payloads** are values a backend could store. They go through JSON and the schema when they are scheduled, so a payload that would not survive storage fails on the local backend too. A task gets its own copy. Dependencies go in the constructor, never in the payload.
- **Results.** `done` finishes a one-off; a recurring job waits for its next pass. `retry` runs the same occurrence again at a time, with the same `executionId` and a higher `attempt`. `next` schedules the next occurrence of a one-off, such as a cron's next time, with a new payload. A recurring job never returns `next`: its passes are already scheduled.
- **`PassTask`** is the Task for one pass of a service's existing work: no payload, and nothing for the manager to decide after it. `new PassTask('accounts.sync', () => this.syncAll())`, whose `type` and `spec` the service schedules with. A singleton uses its task type as the job id.
- **Failures.** A Task reports its own domain failures, with its own log lines and tags, and decides what they mean. A throw that reaches the manager follows the Task's `retryPolicy`, if it has one, and is then reported through error reporting. It never reaches the process's rejection handler, which quits Electron.
- **Scope.** A task runs outside the async scope of whoever scheduled it, as it would on a backend that runs it later elsewhere. `at()` called inside a request does not carry the request's user into the task. A task that acts for a user carries who in its payload, and enters that scope itself with `runWithOptionalUser()`.
- **The signal.** `ctx.signal` aborts when the job is cancelled or dispatch stops. A job replaced by a newer schedule is not aborted: its run finishes, and its result is ignored.

## Scheduling

```ts
await taskManager().at(runAt, `reminder:${id}`, { taskType: 'reminders.send', payload: { scheduleId: id } })
await taskManager().ensureEvery('accounts.sync', { taskType: 'accounts.sync', payload: {} }, { intervalMs: 5 * 60_000, initialDelayMs: 10_000 })
await taskManager().cancel(`reminder:${id}`)
```

- **`at()`** replaces whatever is scheduled under the id, so moving a wakeup is calling `at()` again. It takes a wall-clock time. A long wait is re-checked against the clock at least once a minute, so a wakeup that comes due while the machine sleeps runs within a minute of waking, and a wakeup months away works. A clock set back pushes a waiting wakeup out by as much.
- **`ensureEvery()`** keeps one recurring job per id, and leaves a job already recurring as it is. The first pass comes after `initialDelayMs`, by default one interval. Later passes come on the interval, measured from when the last one came due. A pass that comes due while the last one is still running is skipped, not queued. It waits as an interval timer does: it does not catch up after a sleep.
- **`cancel()`** removes the job and aborts a run in flight.
- **One run per id.** A replacement that comes due while the run before it is still going waits for that run to settle. What a replaced or cancelled run comes back with is ignored, so an old callback cannot rearm cancelled work or erase a newer schedule.
- **`stop()`** clears everything, aborts runs in flight without waiting for them, and ignores anything scheduled after it. Stopping dispatch is not cancelling: a domain's own schedule records stay as they are, for the next start to rebuild. After `stop()`, `taskManager()` still answers, so a late callback has nothing to throw and nothing to resurrect.
- **Calls take effect in the order they are made.** A caller may cancel a job and schedule it again without waiting for the first call, as the relay does when it reconnects, so another backend must keep that order.

## Writing a Service

```ts
class AccountSyncService implements Service {
  readonly id = 'accounts'
  readonly phase = 'background' as const
  readonly tasks = [new AccountSyncTask(this)]

  async start() {
    await taskManager().ensureEvery('accounts.sync', { taskType: 'accounts.sync', payload: {} }, { intervalMs: 5 * 60_000, initialDelayMs: 10_000 })
  }
}

serviceHost().register(new AccountSyncService())
```

- **Registration** registers the Service's Tasks on the manager, and does nothing else.
- **`phase`.** `eager` services start one at a time in registration order, on the path boot waits for. `background` services start together, off that path. A service with no phase starts when its owner calls `startService(id)`, or never, when all it has is a `stop`.
- **`startupIo`.** A background service whose start does open-ended work against the host (image pulls, catch-up, connects) waits for one of the host's three startup slots, in registration order. A start that only registers timers should not take a slot, or it would queue behind an image pull.
- **`critical`.** A failed start of a critical service fails the phase, and in the eager phase leaves the rest unstarted. Any other failed start is logged, and the app runs without that service.
- **`enabled()`** is asked once, when the service would start.
- **`stop()`** runs for every registered service when the host stops, whether or not it got to start, because services hold things lazily. Dispatch stops first. Services stop last registered first, one at a time, and one that fails does not hold up the rest. A start still in flight is not waited for: that service is stopped again when the start settles, so `stop()` must be safe to repeat.

A service needs no `stop()` just to clear a timer, since the manager owns those. It keeps one for resources: sockets, clients, subscriptions.

## The app's services

`backgroundServices()` in `startup.ts` is the catalog of what every entry point runs: a list of instances, since each owner implements `Service` itself. Its order is what matters: `eager` services start in that order, `startupIo` ones take their slots in that order, and everything stops in the reverse of it. So what others use comes first in the list: the runner and the agents are released last, the containers before them, and the relay before the containers, so it claims nothing during their long stop. Host browsers close before the containers they talk to. Dispatch has stopped before any of it.

| Service | Scheduled work | Starts |
| -- | -- | -- |
| `webhook-relay` | Tick (30 s while online), each consumer's retry, the ack retry | eager, critical |
| `container-host` | Status sync (300 s), health check (30 s). Initializes the agents and watches the relay | eager, critical |
| `platform-notifications` | JWT refresh or reconnect (50 min) | background, startup slot |
| `agent-integrations` | Health check (5 min), a chat's stream restore (30 s after a failure), the delivery pump's wakeups | background, startup slot |
| `container-image` | None: pulls or checks the image | background, startup slot |
| `task-scheduler` | Its own poll, for now | background, startup slot |
| `webhook-triggers` | Registration resync (5 min after the last sync, backing off after a failure) | background, startup slot |
| `session-auto-delete`, `api-log-auto-delete` | Cleanup (30 s after start, then every 4 h) | background |
| `account-sync` | Sync (10 s after start, then every 5 min) | background |
| `platform` | Account and billing refresh (10 s after start), cloud-workspace upkeep (30 min) | background |
| `computer-use`, `active-runner`, `agent-registry`, `containers`, `host-browser` | None: they only release resources | stop only |

Electron main adds two of its own, with their existing gates. They are not in web or Cloudflare runtimes:

- **Automatic update checks** (`src/main/auto-updater.ts`): a service with no phase, which Electron's entry point registers after `registerBackgroundWork()`. It starts once the updater is ready and the service is registered, checks 30 s after that, and every 4 hours from then.
- **Spotlight** (`src/main/spotlight/spotlight-sync.ts`): a service with no phase, started once the window and API are up, since it does not depend on the other services starting. It passes 20 s after that, then every 5 minutes; a request for a sync sets a 5 s wakeup that the next request replaces.

The stale-upload sweep (`src/shared/lib/utils/chunked-upload.ts`) is a task with no service around it: `afterBindInitialize` schedules it ahead of the services, because a server whose services failed to start still takes uploads. It sweeps at once, then every 30 minutes, and each pass only sets a sweep going, so a slow sweep does not hold up the next.

**A pass that must not count as running.** The integration and container health checks start their work and return, rather than being awaited. A connect that hangs holds up only its own integration (`reconcilingIds`), and a runtime that hangs on one agent holds up only that pass; if the manager saw a pass as running, it would skip all the later ones. Reach for this only when later passes are safe to run alongside a stuck one.

**Left where they are.** Browser profile maintenance is going away and is not migrated. An agent's auto-sleep is its `IdleAlarm`. Transport heartbeats, request-local timeouts, typing indicators and renderer timers are not background jobs. Neither is the wait between the follow-up passes of a reconnect after system resume (`reconnectAll`), which is one pass in progress.
