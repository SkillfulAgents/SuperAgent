#!/usr/bin/env node
// Record real SDK stream fixtures for the settlement-tracker / persister
// replay tests (src/shared/lib/container/__fixtures__/).
//
// Why: the trackers hold assumptions about the CLI's frame ORDER (idle vs
// result, background_tasks_changed vs task_* bookends) that only a live CLI
// can answer, and those change between SDK releases. Every SDK bump re-records
// these scenarios with the installed SDK and replays them through the tests.
//
// Usage (from the repo root, after `npm ci` in agent-container/; needs
// ANTHROPIC_API_KEY, costs a few cents on haiku):
//   node .claude/skills/update-claude-deps/capture-fixtures.mjs               # all scenarios
//   node .claude/skills/update-claude-deps/capture-fixtures.mjs --only <name> # one
//   node .claude/skills/update-claude-deps/capture-fixtures.mjs --list
//   flags: --model <id> (default claude-haiku-4-5-20251001), --out <dir>, --keep-going
//
// Each scenario writes __fixtures__/sdk<version>-<name>/{stream-input.jsonl,
// metadata.json}; one that sets snapshotTranscripts also writes the session's
// subagent transcripts (fs-snapshot/) and lead transcript. A new directory also needs an entry in FIXTURE_EXPECTATIONS
// (agent-container/src/session-settlement.test.ts) — the discovery test fails
// until it has one, which is the point: someone has to decide what the
// tracker should conclude from the new shape.
//
// The driver mirrors the parts of claude-code.ts buildQueryOptions() that
// shape the stream: streaming input, state events, partial messages,
// progress summaries and perTaskStopAffordance. It does NOT run our system
// prompt, MCP servers or plugin — the fixtures are about protocol shape.
// Frames are written in the host capture wrapper `{t, message: {type,
// content: <frame>}}`, t = ms since the query started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sdkPkgDir = path.join(repoRoot, 'agent-container', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const defaultOut = path.join(repoRoot, 'src', 'shared', 'lib', 'container', '__fixtures__');

// A scenario is a prompt plus optional host actions keyed on stream events.
// Prompts are blunt on purpose: haiku must produce the same tool shape every
// run, so they name the tool, its flags and when to end the turn.
const SCENARIOS = [
  {
    name: 'bg-bash-premature-idle',
    description:
      'Explicit run_in_background:true Bash (`sleep 8`); the lead turn ends while it runs, then the completion wake turn.',
    prompt:
      'Use the Bash tool exactly once with run_in_background: true to run `sleep 8`. Do not wait for it and do not check on it. ' +
      'Reply with the single word "started" and end your turn. When you are later notified that it finished, reply with the single word "done".',
  },
  {
    name: 'bg-subagent-no-idle',
    description:
      'Explicit run_in_background:true subagent that runs a foreground `sleep 5`; the lead turn ends while it runs, then the completion wake turn.',
    prompt: SUBAGENT_PROMPT('Run the Bash command `sleep 5` in the foreground, then reply with the single word "ok".'),
  },
  {
    name: 'bg-subagent-interrupt-noop',
    description:
      'As bg-subagent-no-idle, but the host calls query.interrupt() 1.5s after the lead turn result, while only the background subagent is live (a Stop pressed with no foreground turn).',
    prompt: SUBAGENT_PROMPT('Run the Bash command `sleep 8` in the foreground, then reply with the single word "ok".'),
    interruptAfterFirstResultMs: 1500,
  },
  {
    name: 'bg-subagent-nested-bg-bash',
    description:
      'A background subagent starts its OWN background Bash (`sleep 10`) and ends its turn without waiting, so the subagent reports completed while work it launched is still live. Probes parent_task_id and whether nested tasks appear in the lead snapshot.',
    prompt: SUBAGENT_PROMPT(
      'Use the Bash tool exactly once with run_in_background: true to run `sleep 10`. Do not wait for it. Reply with the single word "started" and end your turn.'
    ),
  },
  {
    name: 'sendmessage-resumed-subagent',
    description:
      'A background subagent completes, then the lead resumes it with SendMessage; probes agent_id / run_id across the two runs.',
    prompt:
      'Step 1: use the Agent tool exactly once with subagent_type "general-purpose", run_in_background: true, description "word probe", and prompt "Reply with the single word alpha." ' +
      'Reply "launched" and end your turn. Step 2: when you are notified that the agent finished, use the SendMessage tool to send that same agent the message "Reply with the single word beta." ' +
      'Reply "resumed" and end your turn. Step 3: when you are notified it finished again, reply with the single word "done".',
  },
  {
    name: 'fork-subagent',
    description:
      'The lead runs a Bash step, then launches a fork (Agent subagent_type "fork", CLI 2.1.302+) that runs its own Bash; the lead turn ends while it runs, then the completion wake turn. Snapshots the transcripts: the fork\'s opens with the parent\'s launching entry and its directive.',
    prompt:
      'Step 1: use the Bash tool to run `echo parent-step-one`. ' +
      'Step 2: use the Agent tool exactly once with subagent_type "fork", description "fork probe", and prompt ' +
      '"Run the Bash command `echo forked-child` and report its output in one line." ' +
      'Then reply with the single word "launched" and end your turn. When you are later notified that the fork finished, reply with the single word "done".',
    snapshotTranscripts: true,
  },
  {
    name: 'fork-sendmessage-resumed',
    description:
      'A fork completes, then the lead resumes it with SendMessage; the second run appends to the fork transcript after its first.',
    prompt:
      'Step 1: use the Bash tool to run `echo parent-step-one`. ' +
      'Step 2: use the Agent tool exactly once with subagent_type "fork", description "fork probe", and prompt "Reply with the single word alpha." ' +
      'Reply "launched" and end your turn. Step 3: when you are notified that the fork finished, use the SendMessage tool to send that same agent ' +
      'the message "Run the Bash command `echo second-run` and reply with its output." Reply "resumed" and end your turn. ' +
      'Step 4: when you are notified it finished again, reply with the single word "done".',
    snapshotTranscripts: true,
  },
];

function SUBAGENT_PROMPT(inner) {
  return (
    'Use the Agent tool exactly once with subagent_type "general-purpose", run_in_background: true, description "bg probe", ' +
    `and this prompt: "${inner}" ` +
    'Then reply with the single word "launched" and end your turn without waiting. When you are later notified that the agent finished, reply with the single word "done".'
  );
}

const TERMINAL_UPDATED = new Set(['completed', 'failed', 'killed']);
const TERMINAL_NOTIFICATION = new Set(['completed', 'failed', 'stopped']);
const MAX_RUN_MS = 180_000;
const QUIET_AFTER_SETTLE_MS = 4_000;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
if (args.includes('--list')) {
  for (const s of SCENARIOS) console.log(`${s.name}\n  ${s.description}`);
  process.exit(0);
}
const only = flag('--only', null);
const model = flag('--model', 'claude-haiku-4-5-20251001');
const outRoot = path.resolve(flag('--out', defaultOut));
const keepGoing = args.includes('--keep-going');
if (!process.env.ANTHROPIC_API_KEY) fail('ANTHROPIC_API_KEY is not set');
if (!fs.existsSync(sdkPkgDir)) fail(`${sdkPkgDir} missing — run npm ci in agent-container/ first`);

const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkPkgDir, 'package.json'), 'utf8')).version;
const cliVersion = `2.1.${sdkVersion.split('.')[2]}`;
const { query } = await import(pathToFileURL(path.join(sdkPkgDir, 'sdk.mjs')).href);

const selected = SCENARIOS.filter((s) => !only || s.name === only);
if (selected.length === 0) fail(`no scenario named "${only}" (see --list)`);

let failures = 0;
for (const scenario of selected) {
  try {
    await capture(scenario);
  } catch (err) {
    failures++;
    console.error(`[${scenario.name}] FAILED: ${err?.stack ?? err}`);
    if (!keepGoing) break;
  }
}
process.exit(failures ? 1 : 0);

async function capture(scenario) {
  const dirName = `sdk${sdkVersion.split('.')[2]}-${scenario.name}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-probe-'));
  // A private config dir: the run must not read (or leak paths from) the
  // operator's ~/.claude — no user hooks, plugins, memory or projects.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-probe-config-'));
  console.log(`\n[${scenario.name}] SDK ${sdkVersion} · ${model} · cwd ${cwd}`);

  // Streaming input that stays open until the run settles, like a host session.
  let closeInput;
  const inputClosed = new Promise((resolve) => (closeInput = resolve));
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: scenario.prompt }, parent_tool_use_id: null, session_id: '' };
    await inputClosed;
  }

  const q = query({
    prompt: input(),
    options: {
      model,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      settingSources: [],
      settings: { disableBundledSkills: true, autoDreamEnabled: false, enableArtifact: false },
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_ARTIFACT: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    },
  });

  const start = Date.now();
  const lines = [];
  const open = new Map(); // task_id -> {taskId, taskType, startedT, prematureIdleT, realCompletionT}
  const tasks = [];
  const subagents = [];
  let results = 0;
  let sessionId;
  let interruptT = null;
  let settledAt = null;
  let lastIdleT = null;

  const watchdog = setTimeout(() => {
    console.error(`[${scenario.name}] watchdog: no settle within ${MAX_RUN_MS}ms, closing input`);
    closeInput();
  }, MAX_RUN_MS);
  let quietTimer = null;
  const armQuiet = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => closeInput(), QUIET_AFTER_SETTLE_MS);
  };

  for await (const frame of q) {
    const t = Date.now() - start;
    lines.push(JSON.stringify({ t, message: { type: frame.type, content: frame } }));
    sessionId ??= frame.session_id;
    if (frame.type === 'result') {
      results++;
      if (results === 1 && scenario.interruptAfterFirstResultMs) {
        setTimeout(async () => {
          interruptT = Date.now() - start;
          const res = await q.interrupt().catch((e) => ({ error: String(e) }));
          console.log(`[${scenario.name}] interrupt at t=${interruptT} → ${JSON.stringify(res)}`);
        }, scenario.interruptAfterFirstResultMs);
      }
    }
    if (frame.type !== 'system') continue;
    switch (frame.subtype) {
      case 'task_started': {
        if (frame.task_type === 'local_agent' && !subagents.some((s) => s.agentId === frame.task_id)) {
          subagents.push({ parentToolId: frame.tool_use_id, taskId: frame.task_id, agentId: frame.task_id, subagentType: frame.subagent_type, description: frame.description });
        }
        const rec = { taskId: frame.task_id, taskType: frame.task_type, startedT: t, prematureIdleT: null, realCompletionT: null };
        if (frame.parent_task_id) rec.parentTaskId = frame.parent_task_id;
        open.set(frame.task_id, rec);
        tasks.push(rec);
        break;
      }
      case 'task_updated':
      case 'task_notification': {
        const status = frame.subtype === 'task_updated' ? frame.patch?.status : frame.status;
        const terminal = (frame.subtype === 'task_updated' ? TERMINAL_UPDATED : TERMINAL_NOTIFICATION).has(status);
        const rec = open.get(frame.task_id);
        if (terminal && rec) {
          rec.realCompletionT = t;
          open.delete(frame.task_id);
        }
        break;
      }
      case 'session_state_changed': {
        if (frame.state === 'idle') {
          lastIdleT = t;
          for (const rec of open.values()) rec.prematureIdleT ??= t;
        }
        break;
      }
    }
    // Settled = idle after at least one result with nothing open; wait a quiet
    // window for trailing frames (a wake turn would re-arm it via running).
    if (frame.subtype === 'session_state_changed') {
      if (frame.state === 'idle' && results > 0 && open.size === 0) {
        settledAt ??= t;
        armQuiet();
      } else if (frame.state === 'running') {
        clearTimeout(quietTimer);
        settledAt = null;
      }
    }
  }
  clearTimeout(watchdog);
  clearTimeout(quietTimer);

  if (settledAt === null) console.warn(`[${scenario.name}] WARNING: run ended without settling (open: ${[...open.keys()].join(', ') || 'none'})`);
  const dir = path.join(outRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stream-input.jsonl'), lines.join('\n') + '\n');
  const metadata = {
    sessionId,
    agentSlug: 'probe',
    sdkVersion,
    cliVersion,
    capturedAt: new Date().toISOString().slice(0, 10),
    model,
    startActive: true,
    subagents,
    source:
      'capture-fixtures.mjs (.claude/skills/update-claude-deps): direct Agent SDK query() with streaming input, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1, includePartialMessages, perTaskStopAffordance; host capture wrapper (t = ms since start, message.content = SDK frame)',
    description: `Real capture (SDK ${sdkVersion} / CLI ${cliVersion}). ${scenario.description}`,
    backgroundTasks: tasks,
    ...(interruptT !== null && { interruptT }),
    ...(settledAt !== null ? { settledT: settledAt } : { settledT: null, lastIdleT }),
    totalEntries: lines.length,
  };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (scenario.snapshotTranscripts) snapshotTranscripts(configDir, sessionId, dir);
  console.log(`[${scenario.name}] ${lines.length} frames, ${tasks.length} task(s), settled ${settledAt ?? 'never'} → ${path.relative(repoRoot, dir)}`);
}

// The session's subagents directory goes to fs-snapshot/ verbatim (the shape
// the host reads through the subagent messages route), and the lead transcript
// to lead-transcript.jsonl with only its message chain (entries with a uuid; a
// fork's fork-context-ref names one, often an attachment): the CLI's
// api-request-* bookkeeping is ~100 KB the host never reads.
function snapshotTranscripts(configDir, sessionId, dir) {
  const projectsDir = path.join(configDir, 'projects');
  const [project] = fs.readdirSync(projectsDir);
  const sessionDir = path.join(projectsDir, project, sessionId);
  const subagentsDir = path.join(sessionDir, 'subagents');
  const snapDir = path.join(dir, 'fs-snapshot');
  fs.mkdirSync(snapDir, { recursive: true });
  for (const name of fs.existsSync(subagentsDir) ? fs.readdirSync(subagentsDir) : []) {
    if (/^agent-[\w-]+\.(jsonl|meta\.json)$/.test(name)) fs.copyFileSync(path.join(subagentsDir, name), path.join(snapDir, name));
  }
  const lead = fs
    .readFileSync(`${sessionDir}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line && typeof JSON.parse(line).uuid === 'string');
  fs.writeFileSync(path.join(dir, 'lead-transcript.jsonl'), lead.join('\n') + '\n');
}

function fail(msg) {
  console.error(`capture-fixtures: ${msg}`);
  process.exit(2);
}
