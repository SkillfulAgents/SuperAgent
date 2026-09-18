/**
 * End-to-end check of a Stop pressed while ONLY a background subagent is live,
 * against the REAL stack (SessionManager → ClaudeCodeProcess → Agent SDK → a
 * real `claude` subprocess talking to the Anthropic API). Nothing is mocked.
 *
 * Since CLI 2.1.269 a headless session emits NO session_state_changed:idle
 * after the lead turn's result while a background subagent is running (see
 * the sdk272-bg-subagent-* fixtures). This file holds in place that:
 *  - the idle-eviction reaper does NOT reap the session while the subagent
 *    is live (settlement stays withheld without an idle event);
 *  - interrupt({scope:'turn'}) in that state is a no-op that keeps the
 *    process — it must not fall back to the restart, which would kill the
 *    subagent perTaskStopAffordance exists to spare;
 *  - the subagent's completion wake still runs to a result, after which the
 *    session settles and is reaped.
 *
 * Opt-in only — costs real API tokens and takes ~1 minute. Run this file
 * ALONE (see session-gc.e2e.test.ts for why the pgrep assertions forbid a
 * parallel E2E worker):
 *   RUN_SESSION_GC_E2E=1 ANTHROPIC_API_KEY=... npx vitest run src/session-gc-background-stop.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ENABLED = process.env.RUN_SESSION_GC_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-haiku-4-5-20251001';

const SDK_BINARY_FRAGMENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '@anthropic-ai'
);
const SDK_BINARY_PATTERN = SDK_BINARY_FRAGMENT.replace(/^(.)/, '[$1]');

function countClaudeSubprocesses(): number {
  try {
    const out = execSync(`pgrep -fl "${SDK_BINARY_PATTERN}"`, { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(label: string, cond: () => boolean, timeoutMs: number, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

type AnyMessage = {
  type?: string;
  subtype?: string;
  state?: string;
  task_id?: string;
  task_type?: string;
  status?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

const results = (msgs: AnyMessage[]) => msgs.filter((m) => m.type === 'result');
const idles = (msgs: AnyMessage[]) =>
  msgs.filter((m) => m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle');
const agentStarts = (msgs: AnyMessage[]) =>
  msgs.filter((m) => m.type === 'system' && m.subtype === 'task_started' && m.task_type === 'local_agent');
const agentCompletions = (msgs: AnyMessage[]) =>
  msgs.filter((m) => m.type === 'system' && m.subtype === 'task_notification' && m.status === 'completed');

describe.skipIf(!ENABLED)('Stop while only a background subagent is live (real CLI subprocess)', () => {
  let workDir: string;
  let SessionManager: typeof import('./session-manager').SessionManager;
  const managers: Array<{ stopAll(): Promise<void> }> = [];

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-gc-bg-stop-e2e-'));
    process.env.SUPERAGENT_SESSIONS_FILE = path.join(workDir, 'sessions.json');
    process.env.CLAUDE_CONFIG_DIR = path.join(workDir, '.claude');
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    ({ SessionManager } = await import('./session-manager'));
    expect(countClaudeSubprocesses()).toBe(0);
  });

  afterAll(async () => {
    for (const m of managers) await m.stopAll();
    await waitFor('all subprocesses gone after stopAll', () => countClaudeSubprocesses() === 0, 15_000);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it(
    'keeps the process and the subagent on Stop, then settles after the completion wake',
    async () => {
      const manager = new SessionManager(workDir, {
        prewarmEnabled: false,
        idleEvictionMs: 5_000,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 1_000,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage:
          'Use the Agent tool with run_in_background set to true to launch a subagent. ' +
          'The subagent\'s prompt must be exactly: "Run `sleep 12` with the Bash tool, then reply with just the word ok." ' +
          'Do not wait for the subagent. As soon as it is launched reply with just the word "launched" and end your turn. ' +
          'When you are later notified that it finished, reply with just the word "finished".',
        metadata: { noninteractive: true },
        model: MODEL,
      });
      const id = session.id;
      const msgs: AnyMessage[] = [];
      manager.subscribe(id, (m) => msgs.push(m as AnyMessage));

      // Lead turn ends with the subagent live.
      await waitFor('subagent started', () => agentStarts(msgs).length >= 1, 120_000);
      await waitFor('lead turn result', () => results(msgs).length >= 1, 120_000);
      expect(agentCompletions(msgs)).toHaveLength(0);
      const processesAfterLead = countClaudeSubprocesses();
      expect(processesAfterLead).toBeGreaterThanOrEqual(1);

      // A Stop now: no foreground turn, so the soft path must be a no-op that
      // keeps the process. (Before the foregroundTurnEnded fix it sent an
      // interrupt nobody answered, waited 5s, then restarted the query —
      // killing the subagent.)
      const t0 = Date.now();
      const outcome = await manager.interruptSession(id, 'turn');
      expect(outcome.found).toBe(true);
      expect(outcome.processKept).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(countClaudeSubprocesses()).toBe(processesAfterLead);
      expect(manager.isSessionRunning(id)).toBe(true);

      // The threshold-0 reaper must NOT take the session while the subagent
      // is live, even though the CLI has emitted no idle since the result.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(manager.isSessionRunning(id)).toBe(true);
      expect(idles(msgs)).toHaveLength(0);

      // The subagent finishes, the wake turn runs, the session settles.
      await waitFor('subagent completed', () => agentCompletions(msgs).length >= 1, 120_000);
      await waitFor('wake turn result', () => results(msgs).length >= 2, 120_000);
      await waitFor('idle after the wake', () => idles(msgs).length >= 1, 30_000);
      await waitFor('subprocess reaped once settled', () => !manager.isSessionRunning(id), 45_000);
      await waitFor('OS process actually exited', () => countClaudeSubprocesses() === 0, 15_000);
    },
    360_000
  );

  // Canary, not a requirement. CLI 2.1.272 holds idle for background
  // SUBAGENTS only: backgrounded Bash still gets the premature idle right
  // after the lead turn's result (fixture sdk272-bg-bash-premature-idle).
  // That asymmetry is what keeps the settlement tracker's background-task
  // bookkeeping (task union, snapshots, wake grace) necessary. When this
  // test fails because no idle arrived before the task completed, the CLI
  // holds idle for every task type — then "idle" alone means settled and the
  // tracker, the wake grace and the foregroundTurnEnded bookkeeping in
  // claude-code.ts can be collapsed. Do that deliberately; do not just fix
  // the assertion.
  it(
    'canary: backgrounded Bash still gets a premature idle before the task completes',
    async () => {
      const manager = new SessionManager(workDir, {
        prewarmEnabled: false,
        idleEvictionMs: 5_000,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 1_000,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage:
          'Use the Bash tool with run_in_background set to true to run exactly this command: `sleep 10 && echo BG_DONE`. ' +
          'Do not wait for it. As soon as it is launched reply with just the word "started" and end your turn. ' +
          'When you are later notified that it finished, reply with just the word "finished".',
        metadata: { noninteractive: true },
        model: MODEL,
      });
      const id = session.id;
      const msgs: AnyMessage[] = [];
      manager.subscribe(id, (m) => msgs.push(m as AnyMessage));

      const bashStarts = () =>
        msgs.filter((m) => m.type === 'system' && m.subtype === 'task_started' && m.task_type === 'local_bash');
      const bashCompletions = () =>
        msgs.filter((m) => m.type === 'system' && m.subtype === 'task_notification' && m.status === 'completed');

      await waitFor('bash task started', () => bashStarts().length >= 1, 120_000);
      await waitFor('lead turn result', () => results(msgs).length >= 1, 120_000);
      await waitFor('premature idle while the task is still running', () => idles(msgs).length >= 1, 5_000);
      expect(bashCompletions()).toHaveLength(0);
      // Even so, the settlement-gated reaper must not take the session.
      expect(manager.isSessionRunning(id)).toBe(true);

      await waitFor('bash task completed', () => bashCompletions().length >= 1, 120_000);
      await waitFor('wake turn result', () => results(msgs).length >= 2, 120_000);
      await waitFor('subprocess reaped once settled', () => !manager.isSessionRunning(id), 45_000);
      await waitFor('OS process actually exited', () => countClaudeSubprocesses() === 0, 15_000);
    },
    360_000
  );
});
