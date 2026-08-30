import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The two session-history helpers the image installs at /opt/gamut/bin. They
 * are the agent's route into its OWN past conversations, so a silent break
 * there sends it back to flailing at the cross-agent tools — which is exactly
 * what `/opt/gamut/docs/session-history.md` exists to prevent.
 *
 * Fixtures below reproduce the transcript shapes that actually bite: a bare
 * string `message.content`, a `queued_command` attachment (how the CLI records
 * a message typed mid-turn), history re-appended verbatim on resume, sidechain
 * (subagent) lines, and the CLI's own `<command-name>` bookkeeping entries.
 */

const BIN = path.join(__dirname, '..', 'bin');
const LIST = path.join(BIN, 'list-sessions.py');
const READ = path.join(BIN, 'read-session.py');

const PYTHON = process.env.PYTHON ?? 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;

// Windows dev boxes may have no python3; CI (ubuntu) always does.
const describeWithPython = hasPython ? describe : describe.skip;

let workspace: string;
let sessionsDir: string;

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry) + '\n';
}

function userText(uuid: string, text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'sess',
    timestamp: '2026-08-20T10:00:00.000Z',
    isSidechain: false,
    message: { role: 'user', content: text },
    ...extra,
  });
}

/** A transcript whose own timestamps — not its mtime — place it in time. */
function sessionAt(iso: string, text: string): string {
  return userText('u1', text, { timestamp: iso });
}

function assistantText(uuid: string, text: string): string {
  return line({
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'sess',
    timestamp: '2026-08-20T10:01:00.000Z',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function assistantToolUse(uuid: string, name: string, input: unknown): string {
  return line({
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'sess',
    timestamp: '2026-08-20T10:02:00.000Z',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'weighing the options' },
        { type: 'tool_use', id: 'toolu_1', name, input },
      ],
    },
  });
}

function toolResult(uuid: string, text: string): string {
  return line({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'sess',
    timestamp: '2026-08-20T10:03:00.000Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }],
    },
  });
}

function run(script: string, args: string[]): string {
  return execFileSync(PYTHON, [script, ...args, '--dir', sessionsDir], {
    encoding: 'utf-8',
  });
}

describeWithPython('session-history helper scripts', () => {
  beforeAll(() => {
    expect(fs.existsSync(LIST)).toBe(true);
    expect(fs.existsSync(READ)).toBe(true);
  });

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'session-history-'));
    sessionsDir = path.join(workspace, '.claude', 'projects', '-workspace');
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function writeSession(id: string, body: string, mtimeMs?: number): string {
    const file = path.join(sessionsDir, `${id}.jsonl`);
    fs.writeFileSync(file, body);
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  describe('list-sessions.py', () => {
    it('lists sessions newest-activity first, headlined by the first user message', () => {
      writeSession('aaaaaaaa-1111', sessionAt('2026-08-20T10:00:00.000Z', 'set up the weekly report'));
      writeSession('bbbbbbbb-2222', sessionAt('2026-08-21T10:00:00.000Z', 'fix the deploy script'));

      const out = run(LIST, []);
      const rows = out.trim().split('\n').filter((l) => l.includes('-'));

      expect(rows[0]).toContain('bbbbbbbb-2222');
      expect(rows[0]).toContain('fix the deploy script');
      expect(rows[1]).toContain('set up the weekly report');
    });

    // Restarting a container re-appends prior history to every transcript,
    // stamping them all with the restart time. Ordering by mtime collapses the
    // whole history into one instant — seen live in E2E, where the agent had to
    // hand-roll a script to recover the real order.
    it('orders by the transcripts own timestamps, not by mtime', () => {
      const sameMtime = Date.UTC(2026, 8, 1, 12, 0, 0);
      writeSession('aaaaaaaa-1111', sessionAt('2026-08-20T10:00:00.000Z', 'the older talk'), sameMtime);
      writeSession('bbbbbbbb-2222', sessionAt('2026-08-21T10:00:00.000Z', 'the newer talk'), sameMtime);

      const rows = run(LIST, []).trim().split('\n');
      expect(rows[0]).toContain('the newer talk');
      expect(rows[0]).toContain('2026-08-21 10:00:00');
      expect(rows[1]).toContain('the older talk');
    });

    it('can sort by start time, oldest first', () => {
      writeSession('aaaaaaaa-1111', sessionAt('2026-08-20T10:00:00.000Z', 'the older talk'));
      writeSession('bbbbbbbb-2222', sessionAt('2026-08-21T10:00:00.000Z', 'the newer talk'));

      const rows = run(LIST, ['--sort', 'started', '--oldest-first']).trim().split('\n');
      expect(rows[0]).toContain('the older talk');
      expect(rows[1]).toContain('the newer talk');
    });

    it('skips CLI bookkeeping entries when picking the headline', () => {
      writeSession(
        'cccccccc-3333',
        userText('u0', '<command-name>/clear</command-name>') +
          userText('u1', '[SYSTEM] a remote MCP server is ready') +
          userText('u2', 'what did we decide about pricing?')
      );

      expect(run(LIST, [])).toContain('what did we decide about pricing?');
    });

    it('reads a mid-turn message from a queued_command attachment', () => {
      writeSession(
        'dddddddd-4444',
        line({
          type: 'attachment',
          uuid: 'a1',
          timestamp: '2026-08-20T10:00:00.000Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            prompt: 'actually, use the staging bucket',
          },
        })
      );

      expect(run(LIST, [])).toContain('actually, use the staging bucket');
    });

    it('prefers the name the app stored in session-metadata.json', () => {
      writeSession('eeeeeeee-5555', userText('u1', 'first thing I typed'));
      fs.writeFileSync(
        path.join(workspace, 'session-metadata.json'),
        JSON.stringify({ 'eeeeeeee-5555': { name: 'Pricing decision', starred: true } })
      );

      const out = run(LIST, []);
      expect(out).toContain('Pricing decision');
      expect(out).toContain('★');
      expect(out).not.toContain('first thing I typed');
    });

    it('filters by --grep across the whole transcript, and by --since', () => {
      const recent = new Date(Date.now() - 3_600_000).toISOString();
      const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
      writeSession('ffffffff-6666', sessionAt(recent, 'talk about kubernetes'));
      writeSession('99999999-7777', sessionAt(old, 'talk about invoices'));

      expect(run(LIST, ['--grep', 'kubernetes'])).toContain('ffffffff-6666');
      expect(run(LIST, ['--grep', 'kubernetes'])).not.toContain('99999999-7777');
      expect(run(LIST, ['--grep', 'kubernetes'])).toContain('hits');
      expect(run(LIST, ['--since', '2d'])).toContain('ffffffff-6666');
      expect(run(LIST, ['--since', '2d'])).not.toContain('99999999-7777');
    });

    // read-session.py prints the transcript's own UTC ISO timestamps. If the
    // listing rendered mtimes in container-local time, the same session would
    // show two different clocks across the two tools — caught live in E2E,
    // where the listing said 10:37 and the transcript said 17:35.
    it('reports timestamps in UTC, matching what read-session.py prints', () => {
      writeSession('aaaa0000-0000', sessionAt('2026-08-20T17:35:00.000Z', 'clock check'));

      const out = run(LIST, []);
      expect(out).toContain('2026-08-20 17:35:00');
      expect(out).toContain('times are UTC');
      expect(run(READ, ['aaaa0000-0000'])).toContain('2026-08-20 17:35:00');
    });

    // A common term matches nearly every session, so a bare match/no-match
    // listing makes the agent hand-roll a `grep -c` ranking pass — watched it
    // happen live on "find the session where we discussed pricing".
    it('ranks --grep results by hit count, not by recency', () => {
      writeSession(
        'dddd1111-0000',
        sessionAt('2026-08-25T10:00:00.000Z', 'a passing mention of pricing')
      );
      writeSession(
        'eeee2222-0000',
        sessionAt('2026-08-20T10:00:00.000Z', 'pricing pricing pricing — the real pricing talk')
      );

      const rows = run(LIST, ['--grep', 'pricing']).trim().split('\n');
      // The older session wins on hits, despite being older.
      expect(rows[0]).toContain('eeee2222-0000');
      expect(rows[1]).toContain('dddd1111-0000');
      expect(run(LIST, ['--grep', 'pricing'])).toContain('best match first');
    });

    it('emits machine-readable rows under --json', () => {
      writeSession('88888888-8888', userText('u1', 'hello there'));

      const rows = JSON.parse(run(LIST, ['--json']));
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('88888888-8888');
      expect(rows[0].first_user_message).toBe('hello there');
    });
  });

  describe('read-session.py', () => {
    it('prints spoken turns only, collapsing tool calls and thinking', () => {
      writeSession(
        '11111111-aaaa',
        userText('u1', 'deploy the api') +
          assistantText('a1', 'On it.') +
          assistantToolUse('a2', 'Bash', { command: 'npm run deploy' }) +
          toolResult('u2', 'deployed to prod') +
          assistantText('a3', 'Deployed.')
      );

      const out = run(READ, ['11111111-aaaa']);
      expect(out).toContain('deploy the api');
      expect(out).toContain('On it.');
      expect(out).toContain('Deployed.');
      expect(out).toContain('⋯ tool calls + thinking ⋯');
      expect(out).not.toContain('npm run deploy');
      expect(out).not.toContain('weighing the options');
    });

    it('shows tool calls, results, and thinking under --full', () => {
      writeSession(
        '22222222-bbbb',
        userText('u1', 'deploy the api') +
          assistantToolUse('a2', 'Bash', { command: 'npm run deploy' }) +
          toolResult('u2', 'deployed to prod')
      );

      const out = run(READ, ['22222222-bbbb', '--full']);
      expect(out).toContain('[tool_use: Bash]');
      expect(out).toContain('npm run deploy');
      expect(out).toContain('[tool_result] deployed to prod');
      expect(out).toContain('[thinking] weighing the options');
    });

    it('does not repeat history that a resume re-appended verbatim', () => {
      const history = userText('u1', 'the original question') + assistantText('a1', 'the answer');
      writeSession('33333333-cccc', history + history + userText('u2', 'a follow-up'));

      const out = run(READ, ['33333333-cccc']);
      expect(out.match(/the original question/g)).toHaveLength(1);
      expect(out).toContain('a follow-up');
    });

    it('hides subagent sidechain turns unless asked for them', () => {
      writeSession(
        '44444444-dddd',
        userText('u1', 'main conversation') +
          userText('s1', 'subagent instructions', { isSidechain: true })
      );

      expect(run(READ, ['44444444-dddd'])).not.toContain('subagent instructions');
      expect(run(READ, ['44444444-dddd', '--sidechains'])).toContain('subagent instructions');
    });

    it('resolves an id prefix and `latest`', () => {
      const sameMtime = Date.UTC(2026, 8, 1, 12, 0, 0);
      writeSession('55555555-eeee', sessionAt('2026-08-20T10:00:00.000Z', 'older session'), sameMtime);
      writeSession('66666666-ffff', sessionAt('2026-08-21T10:00:00.000Z', 'newest session'), sameMtime);

      expect(run(READ, ['55555555'])).toContain('older session');
      expect(run(READ, ['latest'])).toContain('newest session');
      expect(run(READ, ['latest-1'])).toContain('older session');
    });

    it('marks a compaction boundary rather than dropping it silently', () => {
      writeSession(
        '77777777-0000',
        userText('u1', 'before') +
          line({
            type: 'system',
            subtype: 'compact_boundary',
            uuid: 's1',
            isMeta: false,
            content: '',
            timestamp: '2026-08-20T10:05:00.000Z',
          }) +
          userText('u2', 'after')
      );

      expect(run(READ, ['77777777-0000'])).toContain('[context compacted]');
    });

    // deliver_session takes agent_slug as OPTIONAL, and omitting it is what
    // marks the session as the agent's own (deliver-session.tsx falls back to
    // the running agent). A hint that told it to pass a slug would break the
    // same-agent card, so both hints must say to leave it out.
    it('points at deliver_session for its own sessions, with no agent_slug', () => {
      writeSession('bbbb1111-2222', userText('u1', 'the conversation'));

      const read = run(READ, ['bbbb1111-2222']);
      expect(read).toContain('mcp__user-input__deliver_session');
      expect(read).toContain('session_id="bbbb1111-2222"');
      expect(read).toMatch(/omit agent_slug/i);

      const list = run(LIST, []);
      expect(list).toContain('mcp__user-input__deliver_session');
      expect(list).toMatch(/omit\s+agent_slug/i);
    });

    it('keeps the --json listing free of prose hints', () => {
      writeSession('cccc1111-2222', userText('u1', 'machine readable'));

      expect(() => JSON.parse(run(LIST, ['--json']))).not.toThrow();
    });

    it('fails loudly on an ambiguous or unknown session id', () => {
      writeSession('abcd1111-0000', userText('u1', 'one'));
      writeSession('abcd2222-0000', userText('u1', 'two'));

      expect(() => run(READ, ['abcd'])).toThrow(/matches 2 sessions/);
      expect(() => run(READ, ['nope'])).toThrow(/No session matching/);
    });
  });
});
