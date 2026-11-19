import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
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
const MANAGE = path.join(BIN, 'manage-session.py');

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

function run(script: string, args: string[], currentSessionId?: string): string {
  // The container exports GAMUT_SESSION_ID to every tool call; the scripts
  // read it to tell the current conversation apart from past ones. Stripped
  // by default so a developer's own shell can never leak one into the tests.
  // The same for the app's address and token: without them the helpers ask
  // nobody for names, which is what every test not about the app wants.
  const env = { ...process.env };
  delete env.GAMUT_SESSION_ID;
  delete env.SUPERAGENT_HOST_API_URL;
  delete env.PROXY_TOKEN;
  return execFileSync(PYTHON, [script, ...args, '--dir', sessionsDir], {
    encoding: 'utf-8',
    env: currentSessionId ? { ...env, GAMUT_SESSION_ID: currentSessionId } : env,
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

    it('reads a user message recorded as text blocks (how the container starts a session)', () => {
      // Caught live: every session the container itself starts stores the
      // first message as [{type:'text'}], not a string — the headline read
      // "(no user message)" and --grep could not see anything the user typed.
      writeSession(
        '99990000-blocks',
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-20T10:00:00.000Z',
          isSidechain: false,
          message: { role: 'user', content: [{ type: 'text', text: 'Analyze the paywall funnel' }] },
        }) +
          assistantToolUse('a1', 'Bash', { command: 'ls' }) +
          line({
            type: 'user',
            uuid: 'u2',
            timestamp: '2026-08-20T10:00:05.000Z',
            isSidechain: false,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'paywall paywall paywall' }],
            },
          }) +
          assistantText('a2', 'Done.')
      );

      expect(run(LIST, [])).toContain('Analyze the paywall funnel');
      // One hit: the typed message. The tool_result mentioning it three times is not spoken.
      expect(run(LIST, ['--grep', 'paywall'])).toMatch(/99990000-blocks.*\s1 hits/);
      expect(run(LIST, ['--grep', 'funnel'])).toContain('99990000-blocks');
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

    // Caught live: the top "pricing" hit (20 matches) was the agent's own
    // earlier grep for the term — all tool traffic — and the real discussion
    // ranked second. The doc says "trust the ranking", so the ranking must
    // count only what was actually said.
    it('counts --grep hits in spoken turns only, not tool traffic', () => {
      writeSession(
        'aaaa9999-0000',
        [
          sessionAt('2026-08-25T10:00:00.000Z', 'one pricing mention while searching'),
          assistantToolUse('t1', 'Bash', {
            command: 'grep -c pricing pricing pricing pricing *.jsonl',
          }),
          toolResult('t2', 'pricing pricing pricing pricing pricing pricing'),
        ].join('')
      );
      writeSession(
        'bbbb8888-0000',
        [
          sessionAt('2026-08-20T10:00:00.000Z', 'lets settle pricing: pricing tiers'),
          assistantText('a1', 'the pricing plan is three tiers'),
        ].join('')
      );
      // Only tool traffic matches → the session does not match at all.
      writeSession('cccc7777-0000', toolResult('t3', 'pricing pricing pricing'));

      const rows = run(LIST, ['--grep', 'pricing']).trim().split('\n');
      expect(rows[0]).toContain('bbbb8888-0000');
      expect(rows[1]).toContain('aaaa9999-0000');
      expect(run(LIST, ['--grep', 'pricing'])).not.toContain('cccc7777-0000');
    });

    it('does not double --grep counts across a resume replay', () => {
      const original = sessionAt('2026-08-20T10:00:00.000Z', 'the invoicing question');
      // A resume re-appends the prior history verbatim, original uuids and all.
      writeSession('dddd6666-0000', original + original);

      const rows = JSON.parse(run(LIST, ['--grep', 'invoicing', '--json']));
      expect(rows).toHaveLength(1);
      expect(rows[0].matches).toBe(1);
    });

    it('rejects an invalid --grep regex with a clean error, not a traceback', () => {
      writeSession('eeee5555-0000', userText('u1', 'hello'));

      for (const argv of [
        [LIST, '--grep', 'pricing (', '--dir', sessionsDir],
        [READ, 'eeee5555-0000', '--grep', 'pricing (', '--dir', sessionsDir],
      ]) {
        const result = spawnSync(PYTHON, argv, { encoding: 'utf-8' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('invalid regex');
        expect(result.stderr).not.toContain('Traceback');
      }
    });

    it('hides the current session by default and says so, even when nothing else matches', () => {
      // Caught live: a --grep for the topic of the conversation in progress
      // ranked the current session first and the agent read it as prior work.
      writeSession('cccc0000-past', sessionAt('2026-08-01T10:00:00.000Z', 'old paywall talk'));
      writeSession('dddd0000-now', sessionAt('2026-09-06T17:00:00.000Z', 'current paywall analysis'));

      const out = run(LIST, ['--grep', 'paywall'], 'dddd0000-now');
      expect(out).not.toMatch(/^.*dddd0000-now.*analysis/m);
      expect(out).toContain('cccc0000-past');
      expect(out).toContain('Not listed: dddd0000-now — that is THIS session');

      // Only the current session matches: the note must still explain the
      // empty result rather than leaving it looking like a broken directory.
      const none = run(LIST, ['--grep', 'analysis'], 'dddd0000-now');
      expect(none).toContain('No matching sessions.');
      expect(none).toContain('Not listed: dddd0000-now');

      const included = run(LIST, ['--grep', 'paywall', '--include-current'], 'dddd0000-now');
      expect(included).toMatch(/dddd0000-now.*\[THIS IS YOUR CURRENT SESSION/);
      expect(included).not.toContain('Not listed:');

      const json = JSON.parse(run(LIST, ['--json', '--include-current'], 'dddd0000-now'));
      expect(json.map((r: { session_id: string; current: boolean }) => [r.session_id, r.current]))
        .toEqual([['dddd0000-now', true], ['cccc0000-past', false]]);
      expect(JSON.parse(run(LIST, ['--json'], 'dddd0000-now'))).toHaveLength(1);

      // No GAMUT_SESSION_ID (a developer running the script by hand): nothing hidden.
      expect(run(LIST, [])).toContain('dddd0000-now');
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

    it('refuses to read the current session, and `latest` skips it', () => {
      const sameMtime = Date.UTC(2026, 8, 1, 12, 0, 0);
      writeSession('77770000-past', sessionAt('2026-08-20T10:00:00.000Z', 'older session'), sameMtime);
      writeSession('88880000-now', sessionAt('2026-09-06T17:00:00.000Z', 'the conversation in progress'), sameMtime);

      // The current session is (nearly always) the most recently active one,
      // so `latest` has to mean "latest OTHER session".
      expect(run(READ, ['latest'], '88880000-now')).toContain('older session');
      expect(() => run(READ, ['latest-1'], '88880000-now')).toThrow(/not counting the current session/);

      expect(() => run(READ, ['88880000-now'], '88880000-now')).toThrow(/THIS session/);
      expect(() => run(READ, ['8888'], '88880000-now')).toThrow(/THIS session/);

      // Explicit opt-in (e.g. after compaction) still works, minus the card hint.
      const own = run(READ, ['8888', '--allow-current'], '88880000-now');
      expect(own).toContain('the conversation in progress');
      expect(own).toContain('THIS session');
      expect(own).not.toContain('deliver_session');

      // Without GAMUT_SESSION_ID nothing changes.
      expect(run(READ, ['latest'])).toContain('the conversation in progress');
    });

    it('fails loudly on an ambiguous or unknown session id', () => {
      writeSession('abcd1111-0000', userText('u1', 'one'));
      writeSession('abcd2222-0000', userText('u1', 'two'));

      expect(() => run(READ, ['abcd'])).toThrow(/matches 2 sessions/);
      expect(() => run(READ, ['nope'])).toThrow(/No session matching/);
    });
  });

  /**
   * The app, as the helpers reach it: the routes of /api/x-agent/sessions,
   * answering for the one agent whose token this is. A helper is a child
   * process, so it runs asynchronously here: the server has to answer it.
   */
  describe('with the app', () => {
    interface Call { method: string; url: string; authorization: string | undefined; body: unknown }
    let server: http.Server;
    let calls: Call[];
    let names: Record<string, string>;
    let respond: ((call: Call) => { status: number; body?: unknown } | undefined) | undefined;

    beforeEach(async () => {
      calls = [];
      names = {};
      respond = undefined;
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          const call = { method: req.method!, url: req.url!, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
          calls.push(call);
          const answer = respond?.(call) ?? (call.method === 'GET' ? { status: 200, body: { names } }
            : call.method === 'PATCH' ? { status: 200, body: { id: 'x', name: (call.body as { name: string }).name } }
            : { status: 204 });
          res.writeHead(answer.status, { 'Content-Type': 'application/json' });
          res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    function runWithApp(script: string, args: string[], extraEnv: Record<string, string> = {}) {
      const env = { ...process.env, ...extraEnv };
      delete env.GAMUT_SESSION_ID;
      Object.assign(env, {
        SUPERAGENT_HOST_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
        PROXY_TOKEN: 'agent-token',
        // A proxy set for the agent's web traffic must not swallow the call.
        HTTP_PROXY: 'http://127.0.0.1:1',
        http_proxy: 'http://127.0.0.1:1',
        ...extraEnv,
      });
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(PYTHON, [script, ...args], { encoding: 'utf-8', env }, (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
        });
      });
    }
    const list = (args: string[] = [], env?: Record<string, string>) => runWithApp(LIST, [...args, '--dir', sessionsDir], env);

    it('headlines a session by the name it has in the app, and the rest by their first message', async () => {
      writeSession('eeeeeeee-5555', userText('u1', 'first thing I typed'));
      writeSession('ffffffff-6666', userText('u1', 'never named'));
      names = { 'eeeeeeee-5555': 'Pricing decision', 'gone-from-disk': 'No transcript here' };

      const { stdout, code } = await list();

      expect(code).toBe(0);
      expect(stdout).toContain('Pricing decision');
      expect(stdout).not.toContain('first thing I typed');
      expect(stdout).toContain('never named');
      expect(stdout).not.toContain('No transcript here');
      expect(stdout).toContain('manage-session.py');
      expect(calls).toEqual([{ method: 'GET', url: '/api/x-agent/sessions', authorization: 'Bearer agent-token', body: undefined }]);
    });

    it('carries the name in --json, beside the first message', async () => {
      writeSession('eeeeeeee-5555', userText('u1', 'first thing I typed'));
      names = { 'eeeeeeee-5555': 'Pricing decision' };

      const rows = JSON.parse((await list(['--json'])).stdout);

      expect(rows).toEqual([expect.objectContaining({ session_id: 'eeeeeeee-5555', name: 'Pricing decision', first_user_message: 'first thing I typed' })]);
    });

    it('still lists, by first message and saying why, when the app refuses or cannot be reached', async () => {
      writeSession('eeeeeeee-5555', userText('u1', 'first thing I typed'));
      respond = () => ({ status: 500, body: { error: 'Index unavailable' } });

      const refused = await list();
      expect(refused.code).toBe(0);
      expect(refused.stdout).toContain('first thing I typed');
      expect(refused.stdout).toContain('Session names are missing (Index unavailable (HTTP 500))');

      const unreachable = await list([], { SUPERAGENT_HOST_API_URL: 'http://127.0.0.1:1/api' });
      expect(unreachable.code).toBe(0);
      expect(unreachable.stdout).toContain('first thing I typed');
      expect(unreachable.stdout).toContain('Session names are missing (The app could not be reached');

      // --json stays JSON, note or no note.
      expect(JSON.parse((await list(['--json'])).stdout)).toHaveLength(1);
    });

    it('ignores an answer that is not a map of names', async () => {
      writeSession('eeeeeeee-5555', userText('u1', 'first thing I typed'));
      respond = () => ({ status: 200, body: { names: ['not', 'a', 'map'] } });

      expect((await list()).stdout).toContain('first thing I typed');

      respond = () => ({ status: 200, body: { names: { 'eeeeeeee-5555': { not: 'text' } } } });
      expect((await list()).stdout).toContain('first thing I typed');
    });

    it('renames a session through the app, joining an unquoted name', async () => {
      const { stdout, code } = await runWithApp(MANAGE, ['rename', 'eeeeeeee-5555', 'Pricing', 'decision,', 'final']);

      expect(code).toBe(0);
      expect(stdout).toContain('Renamed eeeeeeee-5555 to "Pricing decision, final".');
      expect(calls).toEqual([{
        method: 'PATCH',
        url: '/api/x-agent/sessions/eeeeeeee-5555',
        authorization: 'Bearer agent-token',
        body: { name: 'Pricing decision, final' },
      }]);
    });

    it('deletes a session through the app', async () => {
      const { stdout, code } = await runWithApp(MANAGE, ['delete', 'eeeeeeee-5555']);

      expect(code).toBe(0);
      expect(stdout).toContain('Deleted eeeeeeee-5555.');
      expect(calls).toEqual([{ method: 'DELETE', url: '/api/x-agent/sessions/eeeeeeee-5555', authorization: 'Bearer agent-token', body: undefined }]);
    });

    it('keeps a session id that is not a plain word inside its own path segment', async () => {
      await runWithApp(MANAGE, ['delete', '../other agent/x?y']);

      expect(calls.map((call) => call.url)).toEqual(['/api/x-agent/sessions/..%2Fother%20agent%2Fx%3Fy']);
    });

    it('refuses to delete the session it runs in, without asking the app', async () => {
      const { code, stderr } = await runWithApp(MANAGE, ['delete', '88880000-now'], { GAMUT_SESSION_ID: '88880000-now' });

      expect(code).not.toBe(0);
      expect(stderr).toContain('THIS session');
      expect(calls).toEqual([]);
    });

    it('fails with the app\'s own reason when it refuses', async () => {
      respond = (call) => (call.method === 'DELETE'
        ? { status: 409, body: { error: 'This session is running or waiting for input and cannot be deleted' } }
        : { status: 404, body: { error: 'Session not found' } });

      const deleted = await runWithApp(MANAGE, ['delete', 'busy']);
      expect(deleted.code).not.toBe(0);
      expect(deleted.stderr).toContain('Could not delete busy: This session is running or waiting for input and cannot be deleted (HTTP 409)');

      const renamed = await runWithApp(MANAGE, ['rename', 'nope', 'New name']);
      expect(renamed.code).not.toBe(0);
      expect(renamed.stderr).toContain('Could not rename nope: Session not found (HTTP 404)');
      expect(renamed.stdout).toBe('');
    });

    it('says so when the container has no connection to the app', async () => {
      const { code, stderr } = await runWithApp(MANAGE, ['rename', 'eeeeeeee-5555', 'Name'], { PROXY_TOKEN: '' });

      expect(code).not.toBe(0);
      expect(stderr).toContain('no connection to the app');
      expect(calls).toEqual([]);
    });

    it('asks for an action and a session id', async () => {
      expect((await runWithApp(MANAGE, [])).code).not.toBe(0);
      expect((await runWithApp(MANAGE, ['rename', 'only-an-id'])).code).not.toBe(0);
      expect((await runWithApp(MANAGE, ['rename', 'an-id', '   '])).stderr).toContain('empty');
      expect(calls).toEqual([]);
    });
  });
});
