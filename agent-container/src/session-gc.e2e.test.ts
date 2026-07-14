/**
 * End-to-end session GC validation against the REAL stack: SessionManager →
 * ClaudeCodeProcess → Agent SDK → a real `claude` CLI subprocess talking to
 * the Anthropic API. Nothing is mocked.
 *
 * Verifies, at the OS level (pgrep), that:
 *  - an automated (threshold 0) session's subprocess is reaped by the real
 *    sweep timer once the turn settles, RSS actually released;
 *  - an interactive session with a real timeout survives until the threshold
 *    elapses, then is reaped;
 *  - a reaped session resumes transparently on the next sendMessage, with
 *    conversation context intact (--resume, not a fresh session).
 *
 * Opt-in only — costs real API tokens and takes ~2-4 minutes. Run this file
 * ALONE: the pgrep assertions count every CLI subprocess spawned from this
 * package tree, so another E2E file running in a parallel vitest worker
 * (e.g. session-gc-durability.e2e.test.ts) makes the zero-process checks lie.
 *   RUN_SESSION_GC_E2E=1 ANTHROPIC_API_KEY=... npx vitest run src/session-gc.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ENABLED = process.env.RUN_SESSION_GC_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-haiku-4-5-20251001'; // cheap + fast; the GC is model-agnostic

// The SDK spawns its bundled per-platform binary from THIS package tree —
// counting processes whose cmdline contains this path counts exactly the
// subprocesses this test created (and not, say, a developer's own CLI).
const SDK_BINARY_FRAGMENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '@anthropic-ai'
);

function countClaudeSubprocesses(): number {
  try {
    const out = execSync(`pgrep -fl "${SDK_BINARY_FRAGMENT}"`, { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 on no match
  }
}

async function waitFor(
  label: string,
  cond: () => boolean,
  timeoutMs: number,
  intervalMs = 250
): Promise<void> {
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
  message?: { content?: Array<{ type?: string; text?: string }> };
};

function resultCount(messages: AnyMessage[]): number {
  return messages.filter((m) => m.type === 'result').length;
}

function assistantText(messages: AnyMessage[]): string {
  return messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// The manager keeps no message history (the old unbounded per-session buffer
// backed an endpoint nothing called) — observe the stream the way production
// consumers do: by subscription. Attach right after createSession/getSession
// resolves; turn output only starts after the next sendMessage, so nothing
// the assertions need can be missed. NOTE: a manager-restart resume builds a
// fresh SessionData (fresh subscriber set) — re-collect after it.
function collectMessages(
  manager: { subscribe(id: string, cb: (m: unknown) => void): () => void },
  id: string
): AnyMessage[] {
  const collected: AnyMessage[] = [];
  manager.subscribe(id, (m) => collected.push(m as AnyMessage));
  return collected;
}

describe.skipIf(!ENABLED)('session GC end-to-end (real CLI subprocesses)', () => {
  let workDir: string;
  // Loaded dynamically AFTER the env below is in place.
  let SessionManager: typeof import('./session-manager').SessionManager;
  const managers: Array<{ stopAll(): Promise<void> }> = [];

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-gc-e2e-'));
    // Isolate from the developer machine: our own persistence file, our own
    // CLAUDE_CONFIG_DIR (no personal ~/.claude settings/hooks), and no
    // nested-Claude-Code env bleeding into the child CLI.
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
    'automated session: reaped by the real sweep once settled, resumes with context intact',
    async () => {
      // Interactive threshold is short but nonzero: the human-style resume
      // message below PROMOTES the automated session to the interactive
      // class, so the re-reap at the end exercises the promoted (interactive)
      // path — the first reap exercises the automated (threshold 0) path.
      const manager = new SessionManager(workDir, {
        idleEvictionMs: 5_000,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 1_000,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage:
          'Remember this codeword: kumquat-42. Reply with exactly: OK',
        metadata: { isAutomated: true },
        model: MODEL,
      });
      const id = session.id;
      const msgs = collectMessages(manager, id);

      // Turn completes → a real `claude` subprocess exists and is parked.
      await waitFor(
        'first result',
        () => resultCount(msgs) >= 1,
        120_000
      );
      expect(countClaudeSubprocesses()).toBeGreaterThanOrEqual(1);

      // The REAL 1s sweep timer must reap it (threshold 0, settle-gated).
      await waitFor('subprocess reaped', () => !manager.isSessionRunning(id), 45_000);
      expect(manager.hasActiveSession(id)).toBe(true); // entry survives eviction
      await waitFor('OS process actually exited', () => countClaudeSubprocesses() === 0, 15_000);

      // Resume: next message must restart with --resume, transparently, and
      // the model must still know the codeword — proving the SAME session
      // continued, not a fresh one.
      await manager.sendMessage(
        id,
        'What was the codeword I gave you earlier? Reply with only the codeword.'
      );
      await waitFor(
        'resume result',
        () => resultCount(msgs) >= 2,
        120_000
      );
      expect(assistantText(msgs)).toContain('kumquat-42');

      // And the resumed (now interactive-class, via promotion) turn gets
      // reaped again once its 5s idle threshold elapses.
      await waitFor('re-reaped after resume', () => !manager.isSessionRunning(id), 45_000);
      await waitFor('OS process gone again', () => countClaudeSubprocesses() === 0, 15_000);
    },
    360_000
  );

  it(
    'interactive session: survives until the real timeout elapses, then is reaped and resumable',
    async () => {
      const IDLE_MS = 6_000;
      const manager = new SessionManager(workDir, {
        idleEvictionMs: IDLE_MS,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 1_000,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage: 'Reply with exactly: hello',
        model: MODEL,
      });
      const id = session.id;
      const msgs = collectMessages(manager, id);
      await waitFor(
        'first result',
        () => resultCount(msgs) >= 1,
        120_000
      );
      const settledAt = Date.now();

      // Inside the idle window several sweeps fire — none may evict.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(manager.isSessionRunning(id)).toBe(true);

      // Past the threshold the sweep must take it.
      await waitFor('reaped after timeout', () => !manager.isSessionRunning(id), 45_000);
      expect(Date.now() - settledAt).toBeGreaterThanOrEqual(IDLE_MS - 1_500);

      // Interactive resume path works the same way.
      await manager.sendMessage(id, 'Reply with exactly: hello again');
      await waitFor(
        'resume result',
        () => resultCount(msgs) >= 2,
        120_000
      );
      expect(manager.isSessionRunning(id)).toBe(true);
    },
    360_000
  );
});
