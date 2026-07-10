import { z } from 'zod';

// Session settlement tracking, shared between the container's SessionManager
// (idle-eviction reaper) and the host's message-persister (which re-exports
// the snapshot parsing from here — this file must stay dependency-free apart
// from zod, and must not import anything host- or container-runtime-specific).
//
// "Settled" means: the turn is over (result-gated idle) AND no background
// work (backgrounded Bash, background subagents, dynamic workflows) is live
// AND we are not inside the completion-wake window (see below). Only a
// settled session may have its subprocess stopped.

// --- background_tasks_changed (claude-agent-sdk >= 0.3.203) ---
// The SDK emits the FULL set of the session's live background tasks on every
// membership change. Observed wire ordering (see the sdk206-* fixtures): each
// snapshot LEADS its per-task signal — the frame announcing an addition
// arrives just before task_started, the frame announcing a removal just
// before the terminal task_notification/task_updated. The snapshot covers
// only the lead session's own tasks (a subagent's inner tasks never appear).

const backgroundTaskSchema = z.object({
  task_id: z.string(),
  task_type: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
});

const backgroundTasksChangedSchema = z.object({
  tasks: z.array(backgroundTaskSchema),
});

export interface BackgroundTasksSnapshot {
  taskIds: Set<string>;
  tasks: Array<{ task_id: string; task_type?: string; description?: string }>;
}

/**
 * Parse a background_tasks_changed payload. Returns null when the frame does
 * not validate — the caller must then IGNORE the frame entirely (status quo
 * bookkeeping), because acting on a partially-parsed snapshot could clear
 * tasks that are still running. Fail-safe direction: a dropped frame costs
 * nothing (the next membership change re-announces the full set); a wrong
 * clear un-gates eviction/auto-sleep mid-job.
 */
export function parseBackgroundTasksChanged(content: unknown): BackgroundTasksSnapshot | null {
  const parsed = backgroundTasksChangedSchema.safeParse(content);
  if (!parsed.success) return null;
  return {
    taskIds: new Set(parsed.data.tasks.map((t) => t.task_id)),
    tasks: parsed.data.tasks,
  };
}

// Terminal statuses per frame kind, from the SDK 0.3.206 type unions — they
// differ and must not be merged: SDKTaskUpdatedMessage.patch.status has
// 'killed' (and non-terminal 'paused'), SDKTaskNotificationMessage.status has
// 'stopped' (emitted by Query.stopTask / the TaskStop tool) instead.
export const TERMINAL_TASK_UPDATED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
]);
export const TERMINAL_TASK_NOTIFICATION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'stopped',
]);

// After the LAST background task finishes while the session is idle-parked,
// the SDK wakes the session to deliver the completion to the model: a
// session_state_changed:running arrives 15-64ms later in real captures
// (sdk206-bg-*-premature-idle fixtures), then a wake turn with its own
// result + idle. Settlement is withheld for this grace window so a reaper
// sweep landing in the gap cannot kill the wake. If the wake never comes
// (e.g. the task was stopped with nothing to report), the grace expires and
// the session settles — bounded delay, never a permanent pin.
export const DEFAULT_WAKE_GRACE_MS = 30_000;

export interface SettlementTrackerOptions {
  /**
   * A session resumed by a bare read (no message sent) never gets a turn —
   * no result, no idle event — so it must be born settled or its process
   * would sit beyond any reaper forever.
   */
  bornIdle?: boolean;
  wakeGraceMs?: number;
  /**
   * The consumer KNOWS the process emits session_state_changed events
   * (the container always sets CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 on a
   * pinned CLI), so state events are authoritative from the first frame —
   * before one has actually been observed. Without this, a result arriving
   * before the first state event flips the tracker idle: the pre-init
   * `running` event is dropped by listener-attach timing, and queued-message
   * streams carry intermediate results (see the queued-message-final-response
   * capture: four results before the single final idle) — a threshold-0
   * sweep landing there would evict a session with turns still pending.
   * Fail-safe direction: if the CLI ever stops emitting state events under
   * this flag, sessions stop settling (a bounded leak), rather than settling
   * early (killed queued work).
   */
  stateEventsAuthority?: boolean;
}

export interface SettlementState {
  runtime: 'idle' | 'busy';
  stateEventsSeen: boolean;
  lastResultSubtype: string | null;
  openBackgroundTaskIds: string[];
  awaitingWakeSinceMs: number | null;
}

export class SessionSettlementTracker {
  private runtime: 'idle' | 'busy';
  private stateEventsSeen = false;
  // Cleared on outbound send; set on result. Mirrors message-persister: a
  // bare session_state_changed:idle without a result for this turn is
  // ignored (stale idle racing a fresh message).
  private lastResultSubtype: string | null = null;
  // Edge-tracked tasks (task_started .. terminal signal) unioned with the
  // latest SDK snapshot. The snapshot leads the per-task signals on the wire,
  // so around a membership change each side may briefly know a task the
  // other doesn't; counting the union means a missed registration can't
  // cause premature settlement and a missed terminal signal can't pin the
  // session forever (the snapshot self-heal clears it).
  private edgeTaskIds = new Set<string>();
  private snapshotTaskIds: Set<string> | null = null;
  private awaitingWakeSince: number | null = null;
  private readonly wakeGraceMs: number;

  constructor(options?: SettlementTrackerOptions) {
    this.runtime = options?.bornIdle ? 'idle' : 'busy';
    this.wakeGraceMs = options?.wakeGraceMs ?? DEFAULT_WAKE_GRACE_MS;
    // Authority = behave as if a state event was already seen: results stop
    // acting as idle signals and stream traffic stops acting as busy signals.
    this.stateEventsSeen = options?.stateEventsAuthority ?? false;
  }

  /**
   * Background tasks are process-local: they die with the CLI process, and a
   * fresh process emits NO initial background_tasks_changed snapshot. Any
   * edge/snapshot ids carried across a process replacement (interrupt or
   * crash mid-task, cold restart) would therefore pin the session
   * unevictable forever — no terminal signal or snapshot will ever arrive
   * for them. Call whenever the underlying query/process is replaced; never
   * for ordinary messages within the same process.
   */
  resetBackgroundTasks(): void {
    this.edgeTaskIds.clear();
    this.snapshotTaskIds = null;
    this.awaitingWakeSince = null;
  }

  /**
   * Record a message we are about to hand to the process. A transcript-only
   * append (shouldQuery: false — e.g. cross-agent chat notifications) runs no
   * turn and will produce no result/idle, so it must NOT mark the session
   * busy: that would make it unevictable until the next real turn.
   */
  noteOutboundMessage(options?: { expectsResponse?: boolean }): void {
    if (options?.expectsResponse === false) return;
    this.runtime = 'busy';
    this.lastResultSubtype = null;
    this.awaitingWakeSince = null;
  }

  handleMessage(message: unknown, now: number = Date.now()): void {
    const msg = message as {
      type?: string;
      subtype?: string;
      state?: string;
      task_id?: string;
      status?: string;
      patch?: { status?: string };
    };

    if (msg.type === 'result') {
      this.lastResultSubtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown';
      // A result after the drain IS the wake turn completing.
      this.awaitingWakeSince = null;
      if (!this.stateEventsSeen) {
        this.runtime = 'idle';
      }
      return;
    }

    if (msg.type === 'system') {
      switch (msg.subtype) {
        case 'session_state_changed': {
          this.stateEventsSeen = true;
          if (msg.state === 'idle') {
            // Ignore stale idle with no result for this turn.
            if (this.lastResultSubtype !== null) {
              this.runtime = 'idle';
            }
          } else {
            // running / requires_action — including the completion wake.
            this.runtime = 'busy';
            this.awaitingWakeSince = null;
          }
          return;
        }
        case 'task_started': {
          if (typeof msg.task_id === 'string') {
            this.edgeTaskIds.add(msg.task_id);
          }
          return;
        }
        case 'task_updated': {
          const status = msg.patch?.status;
          if (
            typeof msg.task_id === 'string' &&
            typeof status === 'string' &&
            TERMINAL_TASK_UPDATED_STATUSES.has(status)
          ) {
            this.removeTask(msg.task_id, now);
          }
          return;
        }
        case 'task_notification': {
          if (
            typeof msg.task_id === 'string' &&
            typeof msg.status === 'string' &&
            TERMINAL_TASK_NOTIFICATION_STATUSES.has(msg.status)
          ) {
            this.removeTask(msg.task_id, now);
          }
          return;
        }
        case 'background_tasks_changed': {
          const snapshot = parseBackgroundTasksChanged(msg);
          if (!snapshot) return;
          const hadOpenWork = this.openBackgroundTaskCount > 0;
          this.snapshotTaskIds = snapshot.taskIds;
          // Self-heal: an edge-tracked task the SDK no longer lists has
          // finished — its terminal signal normally follows within a frame
          // and no-ops, but if that signal is missed the task would pin the
          // session forever.
          for (const id of [...this.edgeTaskIds]) {
            if (!snapshot.taskIds.has(id)) {
              this.edgeTaskIds.delete(id);
            }
          }
          this.noteIfDrained(hadOpenWork, now);
          return;
        }
      }
      return;
    }

    if ((msg.type === 'user' || msg.type === 'assistant') && !this.stateEventsSeen) {
      // Legacy streams without state events: any turn traffic means busy.
      // With state events (always, on the pinned SDK) those are authoritative
      // — deliberately NOT flipping busy here is what keeps a shouldQuery:
      // false append's echoed user message from pinning the session busy.
      this.runtime = 'busy';
    }
  }

  private removeTask(taskId: string, now: number): void {
    const hadOpenWork = this.openBackgroundTaskCount > 0;
    this.edgeTaskIds.delete(taskId);
    // A terminal per-task signal normally trails the snapshot that already
    // dropped the task; if a snapshot was missed the union would pin, so the
    // freshest information wins on both sides.
    this.snapshotTaskIds?.delete(taskId);
    this.noteIfDrained(hadOpenWork, now);
  }

  private noteIfDrained(hadOpenWork: boolean, now: number): void {
    if (hadOpenWork && this.openBackgroundTaskCount === 0 && this.runtime === 'idle') {
      this.awaitingWakeSince = now;
    }
  }

  get openBackgroundTaskCount(): number {
    if (!this.snapshotTaskIds) return this.edgeTaskIds.size;
    const union = new Set(this.edgeTaskIds);
    for (const id of this.snapshotTaskIds) union.add(id);
    return union.size;
  }

  isSettled(now: number = Date.now()): boolean {
    if (this.runtime !== 'idle') return false;
    if (this.openBackgroundTaskCount > 0) return false;
    if (this.awaitingWakeSince !== null && now - this.awaitingWakeSince < this.wakeGraceMs) {
      return false;
    }
    return true;
  }

  /** Introspection for logging and tests. */
  getState(): SettlementState {
    return {
      runtime: this.runtime,
      stateEventsSeen: this.stateEventsSeen,
      lastResultSubtype: this.lastResultSubtype,
      openBackgroundTaskIds: [
        ...new Set([...this.edgeTaskIds, ...(this.snapshotTaskIds ?? [])]),
      ],
      awaitingWakeSinceMs: this.awaitingWakeSince,
    };
  }
}
