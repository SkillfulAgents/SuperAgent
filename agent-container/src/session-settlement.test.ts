import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  SessionSettlementTracker,
  parseBackgroundTasksChanged,
  DEFAULT_WAKE_GRACE_MS,
  TERMINAL_TASK_UPDATED_STATUSES,
  TERMINAL_TASK_NOTIFICATION_STATUSES,
} from './session-settlement';

// ---------- frame factories ----------

const result = (subtype = 'success') => ({ type: 'result', subtype });
const state = (s: string) => ({ type: 'system', subtype: 'session_state_changed', state: s });
const taskStarted = (id: string, taskType = 'local_bash') => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  task_type: taskType,
});
const taskUpdated = (id: string, status: string) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: id,
  patch: { status },
});
const taskNotification = (id: string, status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
});
const snapshot = (ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map((task_id) => ({ task_id })),
});
const userMsg = () => ({ type: 'user', message: { role: 'user', content: [] } });
const assistantMsg = () => ({ type: 'assistant', message: { content: [] } });

const T0 = 1_000_000;

/** Fresh tracker driven to a settled state via a completed turn. */
function settledTracker(opts?: { wakeGraceMs?: number }): SessionSettlementTracker {
  const tracker = new SessionSettlementTracker(opts);
  tracker.handleMessage(state('running'), T0);
  tracker.handleMessage(result(), T0);
  tracker.handleMessage(state('idle'), T0);
  expect(tracker.isSettled(T0)).toBe(true);
  return tracker;
}

describe('SessionSettlementTracker — turn lifecycle', () => {
  it('is born busy by default and settles on result + idle', () => {
    const tracker = new SessionSettlementTracker();
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(state('running'), T0);
    tracker.handleMessage(result(), T0);
    expect(tracker.isSettled(T0)).toBe(false); // idle is the authority once state events exist
    tracker.handleMessage(state('idle'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('is born idle when constructed for a bare resume', () => {
    const tracker = new SessionSettlementTracker({ bornIdle: true });
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('treats result alone as settlement when no state events were ever seen (legacy stream)', () => {
    const tracker = new SessionSettlementTracker();
    tracker.handleMessage(result(), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('ignores a stale idle with no result for this turn', () => {
    const tracker = new SessionSettlementTracker();
    tracker.handleMessage(state('idle'), T0); // no result yet — stale
    expect(tracker.isSettled(T0)).toBe(false);
  });

  it('requires_action means busy — never evict a session awaiting permission input', () => {
    const tracker = settledTracker();
    tracker.noteOutboundMessage();
    tracker.handleMessage(state('requires_action'), T0);
    expect(tracker.isSettled(T0)).toBe(false);
  });

  it('a new outbound message clears the previous result gate', () => {
    const tracker = settledTracker();
    tracker.noteOutboundMessage();
    expect(tracker.isSettled(T0)).toBe(false);
    // Stale idle racing the new message must not settle: no result yet.
    tracker.handleMessage(state('idle'), T0);
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(result(), T0);
    tracker.handleMessage(state('idle'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('an error result settles the turn like a success', () => {
    const tracker = new SessionSettlementTracker();
    tracker.handleMessage(state('running'), T0);
    tracker.handleMessage(result('error_during_execution'), T0);
    tracker.handleMessage(state('idle'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });
});

describe('SessionSettlementTracker — outbound messages and stream echoes', () => {
  it('a shouldQuery:false append does not mark the session busy', () => {
    const tracker = settledTracker();
    tracker.noteOutboundMessage({ expectsResponse: false });
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('an echoed user message does not flip busy once state events are the authority', () => {
    // This is what keeps a transcript-only append (whose user message the SDK
    // may replay into the stream) from pinning the session busy forever.
    const tracker = settledTracker();
    tracker.handleMessage(userMsg(), T0);
    tracker.handleMessage(assistantMsg(), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('user/assistant traffic flips busy on legacy streams without state events', () => {
    const tracker = new SessionSettlementTracker();
    tracker.handleMessage(result(), T0); // settled via legacy fallback
    expect(tracker.isSettled(T0)).toBe(true);
    tracker.handleMessage(userMsg(), T0);
    expect(tracker.isSettled(T0)).toBe(false);
  });
});

describe('SessionSettlementTracker — background task edges', () => {
  it.each([...TERMINAL_TASK_UPDATED_STATUSES])(
    'task_updated status %s clears the task',
    (status) => {
      const tracker = settledTracker({ wakeGraceMs: 0 });
      tracker.handleMessage(taskStarted('t1'), T0);
      expect(tracker.isSettled(T0)).toBe(false);
      tracker.handleMessage(taskUpdated('t1', status), T0);
      expect(tracker.isSettled(T0)).toBe(true);
    }
  );

  it.each([...TERMINAL_TASK_NOTIFICATION_STATUSES])(
    'task_notification status %s clears the task',
    (status) => {
      const tracker = settledTracker({ wakeGraceMs: 0 });
      tracker.handleMessage(taskStarted('t1'), T0);
      tracker.handleMessage(taskNotification('t1', status), T0);
      expect(tracker.isSettled(T0)).toBe(true);
    }
  );

  it("task_notification 'stopped' (Query.stopTask / TaskStop) clears the task", () => {
    // 'stopped' exists ONLY on task_notification (SDK type union) — a
    // status list copied from task_updated would leak it and pin the session.
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskNotification('t1', 'stopped'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it.each(['pending', 'running', 'paused'])(
    'non-terminal task_updated status %s does NOT clear the task',
    (status) => {
      const tracker = settledTracker({ wakeGraceMs: 0 });
      tracker.handleMessage(taskStarted('t1'), T0);
      tracker.handleMessage(taskUpdated('t1', status), T0);
      expect(tracker.isSettled(T0)).toBe(false);
    }
  );

  it('an unknown future status does not clear the task (fail toward holding)', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskUpdated('t1', 'suspended'), T0);
    tracker.handleMessage(taskNotification('t1', 'archived'), T0);
    expect(tracker.isSettled(T0)).toBe(false);
  });

  it('holds while ANY of several tasks is open', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskStarted('t2'), T0);
    tracker.handleMessage(taskUpdated('t1', 'completed'), T0);
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(taskUpdated('t2', 'completed'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });
});

describe('SessionSettlementTracker — background_tasks_changed snapshots', () => {
  it('a snapshot-only task blocks settlement (snapshot leads task_started on the wire)', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(snapshot(['t1']), T0);
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(snapshot([]), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('self-heals: an edge-tracked task missing from the snapshot is cleared', () => {
    // A missed terminal signal must not pin the session forever.
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(taskStarted('t1'), T0);
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(snapshot([]), T0); // SDK says: nothing is running
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('union semantics: an edge task missing from an OLDER snapshot still blocks until its terminal signal', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(snapshot(['t1']), T0);
    tracker.handleMessage(taskStarted('t1'), T0);
    // A second task starts edge-first (its announcing snapshot was dropped).
    tracker.handleMessage(taskStarted('t2'), T0);
    tracker.handleMessage(snapshot(['t1']), T0);
    // t2 was self-healed away by the stale snapshot — deliberate: the SDK's
    // full set is authoritative. t1 still blocks.
    expect(tracker.isSettled(T0)).toBe(false);
    tracker.handleMessage(taskNotification('t1', 'completed'), T0);
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('a terminal edge clears a task the (stale) snapshot still lists', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(snapshot(['t1']), T0);
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskNotification('t1', 'completed'), T0); // no fresh snapshot seen
    expect(tracker.isSettled(T0)).toBe(true);
  });

  it('ignores a malformed snapshot frame outright', () => {
    const tracker = settledTracker({ wakeGraceMs: 0 });
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(
      { type: 'system', subtype: 'background_tasks_changed', tasks: 'garbage' },
      T0
    );
    // Acting on a partial parse could clear a running task — must hold.
    expect(tracker.isSettled(T0)).toBe(false);
  });
});

describe('SessionSettlementTracker — completion-wake grace', () => {
  it('withholds settlement after the last task drains while idle (the wake window)', () => {
    const tracker = settledTracker(); // default grace
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskUpdated('t1', 'completed'), T0 + 100);
    // Real captures show session_state_changed:running 15-64ms after the
    // drain; a sweep in that gap must not kill the wake.
    expect(tracker.isSettled(T0 + 120)).toBe(false);
    expect(tracker.isSettled(T0 + 100 + DEFAULT_WAKE_GRACE_MS - 1)).toBe(false);
  });

  it('the wake (running) clears the grace and the wake turn settles normally', () => {
    const tracker = settledTracker();
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskNotification('t1', 'completed'), T0 + 100);
    tracker.handleMessage(state('running'), T0 + 130);
    expect(tracker.isSettled(T0 + 140)).toBe(false); // busy: wake turn running
    tracker.handleMessage(result(), T0 + 500);
    tracker.handleMessage(state('idle'), T0 + 501);
    expect(tracker.isSettled(T0 + 502)).toBe(true);
  });

  it('settles after the grace expires when no wake ever comes (bounded, never a pin)', () => {
    const tracker = settledTracker();
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskNotification('t1', 'stopped'), T0 + 100);
    expect(tracker.isSettled(T0 + 200)).toBe(false);
    expect(tracker.isSettled(T0 + 100 + DEFAULT_WAKE_GRACE_MS + 1)).toBe(true);
  });

  it('no grace when the drain happens mid-turn (busy-path completion)', () => {
    const tracker = settledTracker();
    tracker.noteOutboundMessage();
    tracker.handleMessage(state('running'), T0);
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskUpdated('t1', 'completed'), T0 + 50); // turn still running
    tracker.handleMessage(result(), T0 + 100);
    tracker.handleMessage(state('idle'), T0 + 101);
    // The running turn already absorbed the completion — no wake to wait for.
    expect(tracker.isSettled(T0 + 102)).toBe(true);
  });

  it('only the LAST task draining while idle arms the grace', () => {
    const tracker = settledTracker();
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskStarted('t2'), T0);
    tracker.handleMessage(taskUpdated('t1', 'completed'), T0 + 100);
    // Still one open task — blocked by the task itself, not the grace.
    expect(tracker.getState().awaitingWakeSinceMs).toBeNull();
    tracker.handleMessage(taskUpdated('t2', 'completed'), T0 + 200);
    expect(tracker.getState().awaitingWakeSinceMs).toBe(T0 + 200);
  });

  it('a fresh outbound message clears a pending grace', () => {
    const tracker = settledTracker();
    tracker.handleMessage(taskStarted('t1'), T0);
    tracker.handleMessage(taskUpdated('t1', 'completed'), T0 + 100);
    tracker.noteOutboundMessage();
    expect(tracker.getState().awaitingWakeSinceMs).toBeNull();
    expect(tracker.isSettled(T0 + 200)).toBe(false); // busy: new turn pending
  });
});

describe('parseBackgroundTasksChanged', () => {
  it('parses a valid snapshot', () => {
    const parsed = parseBackgroundTasksChanged({
      tasks: [{ task_id: 'a', task_type: 'local_bash' }, { task_id: 'b' }],
    });
    expect(parsed).not.toBeNull();
    expect([...parsed!.taskIds]).toEqual(['a', 'b']);
  });

  it('tolerates unexpected field types on optional fields', () => {
    const parsed = parseBackgroundTasksChanged({
      tasks: [{ task_id: 'a', task_type: 123, description: { nested: true } }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.tasks[0]).toEqual({ task_id: 'a' });
  });

  it('rejects frames without a valid tasks array', () => {
    expect(parseBackgroundTasksChanged({})).toBeNull();
    expect(parseBackgroundTasksChanged({ tasks: 'nope' })).toBeNull();
    expect(parseBackgroundTasksChanged({ tasks: [{ no_id: true }] })).toBeNull();
    expect(parseBackgroundTasksChanged(null)).toBeNull();
  });
});

// ---------- real-capture replay ----------
//
// Every capture fixture is replayed through the tracker with its original
// timestamps. `settledAtEnd` is ground truth read off each capture's tail:
// captures that end with a post-result `idle` are settled; captures truncated
// at the final `result` (older harness) or killed mid-flight (old-flow
// interrupt: the stream just STOPS) are not.

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/lib/container/__fixtures__'
);

interface FixtureExpectation {
  name: string;
  settledAtEnd: boolean;
}

// The older captures are truncated at their final result, but by then every
// task has closed and a post-result idle was already accepted — the stream's
// last known state is settled, and the tracker says so.
const FIXTURE_EXPECTATIONS: FixtureExpectation[] = [
  { name: 'background-bash-busy-completion', settledAtEnd: true },
  { name: 'background-bash-premature-idle', settledAtEnd: true },
  { name: 'background-subagent-completion', settledAtEnd: true },
  { name: 'background-subagent-premature-idle', settledAtEnd: true },
  { name: 'parallel-subagents', settledAtEnd: true },
  { name: 'queued-message-final-response', settledAtEnd: true },
  { name: 'sdk206-bg-bash-busy-completion', settledAtEnd: true },
  { name: 'sdk206-bg-bash-two-tasks-premature-idle', settledAtEnd: true },
  { name: 'sdk206-bg-subagent-default', settledAtEnd: true },
  { name: 'sdk206-bg-subagent-premature-idle', settledAtEnd: true },
  { name: 'sdk206-error-turn-invalid-model', settledAtEnd: true },
  { name: 'sdk206-parallel-subagents-sync', settledAtEnd: true },
  { name: 'sdk206-queued-message-final-response', settledAtEnd: true },
  { name: 'sdk206-queued-message-interrupt', settledAtEnd: false }, // stream stops post-abort
  { name: 'sdk206-queued-message-interrupt-receipt', settledAtEnd: true },
  { name: 'sdk206-sequential-different-types', settledAtEnd: true },
  { name: 'sdk206-workflow-probe', settledAtEnd: true },
  { name: 'sequential-different-types', settledAtEnd: true },
  { name: 'single-subagent-progress', settledAtEnd: true },
];

interface CapturedFrame {
  t: number;
  frame: Record<string, unknown>;
}

function loadFixture(name: string): CapturedFrame[] {
  const file = path.join(FIXTURES_DIR, name, 'stream-input.jsonl');
  return fs
    .readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .flatMap((line) => {
      try {
        const wrapper = JSON.parse(line) as { t: number; message?: { content?: unknown } };
        const frame = wrapper.message?.content;
        if (!frame || typeof frame !== 'object') return [];
        return [{ t: wrapper.t, frame: frame as Record<string, unknown> }];
      } catch {
        return [];
      }
    });
}

function replay(frames: CapturedFrame[], tracker: SessionSettlementTracker): void {
  for (const { t, frame } of frames) {
    tracker.handleMessage(frame, t);
  }
}

describe('SessionSettlementTracker — real capture replay', () => {
  it('covers every capture fixture in the repo', () => {
    const onDisk = fs
      .readdirSync(FIXTURES_DIR)
      .filter((d) => fs.existsSync(path.join(FIXTURES_DIR, d, 'stream-input.jsonl')))
      .sort();
    expect(onDisk).toEqual(FIXTURE_EXPECTATIONS.map((f) => f.name).sort());
  });

  it.each(FIXTURE_EXPECTATIONS)('$name replays to settledAtEnd=$settledAtEnd', (fixture) => {
    const frames = loadFixture(fixture.name);
    expect(frames.length).toBeGreaterThan(0);
    const tracker = new SessionSettlementTracker();
    tracker.noteOutboundMessage(); // the capture's driver sent the initial message
    replay(frames, tracker);
    const endT = frames[frames.length - 1].t;
    // Past any wake grace — this asserts steady-state, not the gap.
    expect(tracker.isSettled(endT + DEFAULT_WAKE_GRACE_MS + 1)).toBe(fixture.settledAtEnd);
  });

  it('is never settled while the capture has an open background task (frame-by-frame)', () => {
    // Reference bookkeeping derived ONLY from per-task edges (task_started ..
    // first terminal signal) — independent of the tracker's snapshot/union
    // logic, so a tracker bug can't cancel out of both sides.
    for (const { name } of FIXTURE_EXPECTATIONS) {
      const frames = loadFixture(name);
      const open = new Set<string>();
      const tracker = new SessionSettlementTracker();
      tracker.noteOutboundMessage();
      for (const { t, frame } of frames) {
        tracker.handleMessage(frame, t);
        const f = frame as {
          subtype?: string;
          task_id?: string;
          status?: string;
          patch?: { status?: string };
        };
        if (f.subtype === 'task_started' && f.task_id) open.add(f.task_id);
        const terminalUpdate =
          f.subtype === 'task_updated' &&
          f.patch?.status &&
          TERMINAL_TASK_UPDATED_STATUSES.has(f.patch.status);
        const terminalNotif =
          f.subtype === 'task_notification' &&
          f.status &&
          TERMINAL_TASK_NOTIFICATION_STATUSES.has(f.status);
        if ((terminalUpdate || terminalNotif) && f.task_id) open.delete(f.task_id);
        if (open.size > 0) {
          expect(tracker.isSettled(t), `${name}: settled with ${[...open]} open at t=${t}`).toBe(
            false
          );
        }
      }
    }
  });

  it('holds through the measured wake gap in sdk206-bg-bash-two-tasks-premature-idle', () => {
    // Ground truth from the capture: background_tasks_changed [] at t=230591
    // (state still idle from t=210739), the wake's running at t=230624 — a
    // 33ms window in which the PR-419 bookkeeping was evictable.
    const frames = loadFixture('sdk206-bg-bash-two-tasks-premature-idle');
    const tracker = new SessionSettlementTracker();
    tracker.noteOutboundMessage();
    for (const { t, frame } of frames) {
      if (t >= 230624) break; // stop right before the wake's running frame
      tracker.handleMessage(frame, t);
    }
    expect(tracker.openBackgroundTaskCount).toBe(0);
    expect(tracker.getState().runtime).toBe('idle');
    // A sweep landing inside the gap must hold.
    expect(tracker.isSettled(230600)).toBe(false);
    expect(tracker.isSettled(230623)).toBe(false);
  });

  it('holds through the measured wake gap in sdk206-bg-subagent-premature-idle', () => {
    // Snapshot [] at t=274817, wake running at t=274832 — a 15ms window.
    const frames = loadFixture('sdk206-bg-subagent-premature-idle');
    const tracker = new SessionSettlementTracker();
    tracker.noteOutboundMessage();
    for (const { t, frame } of frames) {
      if (t >= 274832) break;
      tracker.handleMessage(frame, t);
    }
    expect(tracker.isSettled(274825)).toBe(false);
  });

  it("a subagent's inner bash edges never pin settlement past the subagent itself", () => {
    // In sdk206-bg-subagent-premature-idle the subagent's inner Bash
    // (task_started without a snapshot entry) flows through the lead stream.
    // After the full replay + grace the session must settle — a tracker that
    // required an explicit terminal signal for every edge would pin here if
    // any inner edge went unmatched.
    const frames = loadFixture('sdk206-bg-subagent-premature-idle');
    const tracker = new SessionSettlementTracker();
    tracker.noteOutboundMessage();
    replay(frames, tracker);
    const endT = frames[frames.length - 1].t;
    expect(tracker.isSettled(endT + DEFAULT_WAKE_GRACE_MS + 1)).toBe(true);
    expect(tracker.openBackgroundTaskCount).toBe(0);
  });
});
