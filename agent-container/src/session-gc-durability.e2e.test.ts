/**
 * Live durability E2E for session GC: proves eviction cannot lose transcript
 * data. Disk forensics (grepping the CLI's own JSONL transcripts between
 * phases) separate "transcript never written" from "resume mechanics broken"
 * from "model answered badly".
 *
 * Regression background: eviction originally stopped the CLI with an
 * immediate abort, racing its transcript flush — identical runs lost the
 * latest turn's context on some runs and kept it on others, and a
 * shouldQuery:false append into a cold threshold-0 session could be killed
 * mid-boot before the append ever reached disk. Eviction now stops the CLI
 * gracefully (stdin EOF, bounded), which these tests hold in place.
 *
 * Opt-in only — costs real API tokens (~20s on haiku). Run separately from
 * session-gc.e2e.test.ts: its pgrep-based zero-process assertions see this
 * file's subprocesses when both run in parallel vitest workers.
 *   RUN_SESSION_GC_E2E=1 ANTHROPIC_API_KEY=... npx vitest run src/session-gc-durability.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ENABLED = process.env.RUN_SESSION_GC_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const LOG = process.env.PROBE_LOG_FILE || '';
const T0 = Date.now();

function dlog(msg: string): void {
  if (LOG) fs.appendFileSync(LOG, `[+${((Date.now() - T0) / 1000).toFixed(2)}s] ${msg}\n`);
}

type AnyMessage = {
  type?: string;
  subtype?: string;
  state?: string;
  is_error?: boolean;
  error?: unknown;
  result?: unknown;
  session_id?: string;
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

function describeMessages(messages: AnyMessage[]): string {
  return messages
    .filter((m) => m.type !== 'stream_event')
    .map((m) => {
      const bits = [m.type, m.subtype, m.state].filter(Boolean).join('/');
      const err = m.is_error || m.error ? ` ERR=${JSON.stringify(m.error ?? m.result ?? true)}` : '';
      const text =
        m.type === 'assistant' || m.type === 'user'
          ? ` "${(m.message?.content ?? []).map((b) => b.text ?? `[${b.type}]`).join('').slice(0, 80)}"`
          : '';
      return `${bits}${err}${text}`;
    })
    .join(' | ');
}

/** All CLI transcript JSONL files under the probe's CLAUDE_CONFIG_DIR-adjacent project dirs. */
function transcriptFiles(configDir: string): Array<{ file: string; size: number }> {
  const out: Array<{ file: string; size: number }> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl')) out.push({ file: p, size: fs.statSync(p).size });
    }
  };
  walk(path.join(configDir, 'projects'));
  return out;
}

function grepTranscripts(configDir: string, needle: string): string[] {
  return transcriptFiles(configDir)
    .filter(({ file }) => fs.readFileSync(file, 'utf-8').includes(needle))
    .map(({ file }) => path.basename(file));
}

function logDisk(configDir: string, label: string, needles: string[]): void {
  const files = transcriptFiles(configDir)
    .map((f) => `${path.basename(f.file)}:${f.size}B`)
    .join(', ');
  dlog(`${label}: transcripts=[${files}]`);
  for (const needle of needles) {
    dlog(`${label}: "${needle}" in ${JSON.stringify(grepTranscripts(configDir, needle))}`);
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

describe.skipIf(!ENABLED)('session GC durability (live, disk forensics)', () => {
  let workDir: string;
  let configDir: string;
  let SessionManager: typeof import('./session-manager').SessionManager;
  const managers: Array<{ stopAll(): Promise<void> }> = [];

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-durability-'));
    configDir = path.join(workDir, '.claude');
    process.env.SUPERAGENT_SESSIONS_FILE = path.join(workDir, 'sessions.json');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    ({ SessionManager } = await import('./session-manager'));
  });

  afterAll(async () => {
    for (const m of managers) await m.stopAll();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it(
    'turns from a resumed (post-eviction) query survive on disk and across a manager restart',
    async () => {
      const manager = new SessionManager(workDir, {
        idleEvictionMs: 0,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 500,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage: 'Remember: codeword one is papaya-7. Reply with exactly: OK',
        metadata: { isAutomated: true },
        model: MODEL,
      });
      const id = session.id;
      dlog(`A2: created ${id}`);

      await waitFor('A2 first result', () => resultCount(manager.getMessages(id)) >= 1, 120_000);
      await waitFor('A2 reaped once', () => !manager.isSessionRunning(id), 45_000);
      logDisk(configDir, 'A2 after evict#1', ['papaya-7']);

      await manager.sendMessage(id, 'Remember: codeword two is walnut-9. Reply with exactly: OK');
      await waitFor('A2 second result', () => resultCount(manager.getMessages(id)) >= 2, 120_000);
      dlog(`A2 turn-2 msgs: ${describeMessages(manager.getMessages(id))}`);
      logDisk(configDir, 'A2 after turn 2 (pre-evict)', ['papaya-7', 'walnut-9']);
      await waitFor('A2 reaped twice', () => !manager.isSessionRunning(id), 45_000);
      // Give the CLI a beat, then check what survived the eviction kill.
      await new Promise((r) => setTimeout(r, 1_500));
      logDisk(configDir, 'A2 after evict#2', ['papaya-7', 'walnut-9']);

      // Fresh manager = container restart.
      await manager.stopAll();
      const manager2 = new SessionManager(workDir, {
        idleEvictionMs: 60 * 60_000,
        automatedIdleEvictionMs: 60 * 60_000,
        evictionPollMs: 60_000,
      });
      managers.push(manager2);
      await manager2.sendMessage(
        id,
        'What are codeword one and codeword two? Reply with only the two codewords.'
      );
      await waitFor('A2 post-restart result', () => resultCount(manager2.getMessages(id)) >= 1, 120_000);
      const reply = assistantText(manager2.getMessages(id));
      dlog(`A2 post-restart msgs: ${describeMessages(manager2.getMessages(id))}`);
      dlog(`A2: post-restart reply=${JSON.stringify(reply)}`);

      expect(reply).toContain('papaya-7');
      expect(reply).toContain('walnut-9');
    },
    360_000
  );

  it(
    'a shouldQuery:false append into a cold automated session reaches disk despite instant eviction',
    async () => {
      const manager = new SessionManager(workDir, {
        idleEvictionMs: 0,
        automatedIdleEvictionMs: 0,
        evictionPollMs: 250,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage: 'Reply with exactly: ready',
        metadata: { isAutomated: true },
        model: MODEL,
      });
      const id = session.id;
      await waitFor('D2 first result', () => resultCount(manager.getMessages(id)) >= 1, 120_000);
      await waitFor('D2 reaped', () => !manager.isSessionRunning(id), 45_000);
      logDisk(configDir, 'D2 after evict#1', ['ready']);
      dlog('D2: appending notification with shouldQuery:false into cold session');

      await manager.sendMessage(
        id,
        '[Notification from agent finance-bot]: The Q3 report is ready at /tmp/q3-report-xyzzy.pdf',
        undefined,
        { shouldQuery: false }
      );
      await waitFor('D2 re-reaped after append', () => !manager.isSessionRunning(id), 45_000);
      await new Promise((r) => setTimeout(r, 2_000));
      dlog(`D2 post-append msgs: ${describeMessages(manager.getMessages(id))}`);
      logDisk(configDir, 'D2 after append+evict', ['q3-report-xyzzy']);

      const baseline = resultCount(manager.getMessages(id));
      await manager.sendMessage(
        id,
        'What file path did the notification from finance-bot mention? Reply with only the path.'
      );
      await waitFor(
        'D2 question result',
        () => resultCount(manager.getMessages(id)) > baseline,
        120_000
      );
      const reply = assistantText(manager.getMessages(id));
      dlog(`D2 all msgs: ${describeMessages(manager.getMessages(id))}`);
      dlog(`D2: reply=${JSON.stringify(reply)}`);

      // Invariant: the transcript-only append must not be silently lost.
      expect(grepTranscripts(configDir, 'q3-report-xyzzy')).not.toEqual([]);
      expect(reply).toContain('q3-report-xyzzy.pdf');
    },
    360_000
  );

  it(
    'a message queued mid-turn survives an aggressive reaper (no idle gap between chained turns)',
    async () => {
      // Guards a CLI-behavior assumption the reaper depends on: the CLI does
      // NOT emit session_state_changed:idle between a finished turn and a
      // queued follow-up. If a future CLI/SDK does, a threshold-0 sweep
      // landing in that gap would evict and silently kill the queued message.
      const manager = new SessionManager(workDir, {
        idleEvictionMs: 0, // human promotion flips class → keep both classes at 0
        automatedIdleEvictionMs: 0,
        evictionPollMs: 250,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage: 'Reply with exactly: alpha-one',
        metadata: { isAutomated: true },
        model: MODEL,
      });
      const id = session.id;
      // Queue a second message while turn 1 is (very likely) still running.
      await manager.sendMessage(id, 'Reply with exactly: beta-two');

      await waitFor('both chained results', () => resultCount(manager.getMessages(id)) >= 2, 120_000);
      const text = assistantText(manager.getMessages(id));
      dlog(`chained-turns text=${JSON.stringify(text)}`);
      expect(text).toContain('alpha-one');
      expect(text).toContain('beta-two');
    },
    360_000
  );

  it(
    'an interrupted session settles and is reaped (no permanent busy-pin leak)',
    async () => {
      // Guards the other CLI-behavior assumption: an interrupt yields a
      // result (error_during_execution) + idle, so the tracker settles and
      // the fresh parked query gets reaped. If an SDK change stops emitting
      // those frames, every user Stop would pin a ~250MB subprocess forever.
      const manager = new SessionManager(workDir, {
        idleEvictionMs: 3_000,
        automatedIdleEvictionMs: -1,
        evictionPollMs: 500,
      });
      managers.push(manager);

      const session = await manager.createSession({
        initialMessage:
          'Write a numbered list of 60 short sentences about the ocean, one per line. Do not stop early.',
        model: MODEL,
      });
      const id = session.id;

      // Interrupt mid-turn, then the restarted parked query must become
      // settled and get reaped by the real sweep.
      await new Promise((r) => setTimeout(r, 2_500));
      const outcome = await manager.interruptSession(id);
      dlog(`interrupt outcome=${JSON.stringify(outcome)}`);
      expect(outcome.found).toBe(true);

      await waitFor('reaped after interrupt', () => !manager.isSessionRunning(id), 45_000);
    },
    360_000
  );
});
