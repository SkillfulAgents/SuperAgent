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

Each entry point awaits `prepareBackgroundWork()` from `startup.ts` after the database, AppState and key custody, and before it serves anything, because a request can schedule work as soon as the API is bound. The entry points are Electron main, `src/web/server.ts` and the Vite dev server's `server-lifecycle` plugin. `perf/harness.ts`, which boots only the API, calls `initializeLocalBackgroundWork()` directly. Importing these modules starts no timer and does no I/O. `taskManager()` and `serviceHost()` before initialization throw.

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
- **Failures.** A Task reports its own domain failures, with its own log lines and tags, and decides what they mean. A throw that reaches the manager follows the Task's `retryPolicy`, if it has one, and is then reported through error reporting. It never reaches the process's rejection handler, which quits Electron.
- **Scope.** A task runs outside the async scope of whoever scheduled it, as it would on a backend that runs it later elsewhere. `at()` called inside a request does not carry the request's user into the task. A task that acts for a user carries who in its payload, and enters that scope itself with `runWithOptionalUser()`.
- **The signal.** `ctx.signal` aborts when the job is cancelled or dispatch stops. A job replaced by a newer schedule is not aborted: its run finishes, and its result is ignored.

## Scheduling

```ts
await taskManager().at(runAt, `reminder:${id}`, { taskType: 'reminders.send', payload: { scheduleId: id } })
await taskManager().ensureEvery('accounts.sync', { taskType: 'accounts.sync', payload: {} }, { intervalMs: 5 * 60_000, initialDelayMs: 10_000 })
await taskManager().cancel(`reminder:${id}`)
```

- **`at()`** replaces whatever is scheduled under the id, so moving a wakeup is calling `at()` again. It takes a wall-clock time. A long wait is re-checked against the clock at least once a minute, so a wakeup that comes due while the machine sleeps runs within a minute of waking, and a wakeup months away works.
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
