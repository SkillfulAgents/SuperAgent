#!/usr/bin/env node
// Extract a workflow script that ships inside the Claude Code CLI binary and
// compare it with the copy we vendor under agent-container/plugin/workflows/.
//
// Why: agent-container sets `disableBundledSkills: true`, which hides every
// skill and workflow bundled in the CLI, and vendors the one we still want
// (deep-research). That copy stops tracking upstream, so every SDK bump must
// re-extract and diff it. See .claude/skills/update-claude-deps/SKILL.md.
//
// Usage (from the repo root, after `npm ci` in agent-container/):
//   node .claude/skills/update-claude-deps/extract-bundled-workflow.mjs            # diff, exit 1 on drift
//   node .claude/skills/update-claude-deps/extract-bundled-workflow.mjs --write    # overwrite the vendored copy
//   node .claude/skills/update-claude-deps/extract-bundled-workflow.mjs --name x   # another bundled workflow
//
// How: the CLI is a single bun-compiled binary whose JS chunks are embedded as
// text. The bundled-workflows chunk declares each workflow as
// `var i="<name>",e=i,t="<description>",...` followed by a registration call
// whose first argument is the script as a template literal, and ends with
// `export{<fn> as initBundledWorkflows}`. We slice that chunk out, stub every
// free function it calls, run it in a vm, and capture the registration.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Deliberate local edits, applied to the upstream script before it is compared
// or written. Keep this list tiny and mechanical. Each entry must match at
// least once or the extractor fails (exit 2): that means upstream rewrote the
// text the patch targets and a human has to look.
//
// deep-research: a plugin workflow is addressed as `<plugin>:<name>`, so the
// usage hint the script prints when called without a question must say
// `gamut:deep-research`, not the bare name upstream uses. (`meta.name` itself
// stays bare - the CLI adds the plugin prefix.)
const LOCAL_PATCHES = {
  'deep-research': [
    { from: "Workflow({name: 'deep-research'", to: "Workflow({name: 'gamut:deep-research'" },
  ],
};

const args = process.argv.slice(2);
const write = args.includes('--write');
const nameIdx = args.indexOf('--name');
const name = nameIdx >= 0 ? args[nameIdx + 1] : 'deep-research';
if (!name) fail('--name needs a value');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sdkDir = path.join(repoRoot, 'agent-container', 'node_modules', '@anthropic-ai');
const vendored = path.join(repoRoot, 'agent-container', 'plugin', 'workflows', `${name}.js`);

const binary = findBinary();
const sdkVersion = readJson(path.join(sdkDir, 'claude-agent-sdk', 'package.json')).version;
console.log(`SDK ${sdkVersion} · ${path.relative(repoRoot, binary)}`);

const { script: upstream, meta } = extract(fs.readFileSync(binary), name);
console.log(`upstream ${meta.name}: ${meta.description}`);
const script = applyLocalPatches(upstream, name);

if (write) {
  fs.mkdirSync(path.dirname(vendored), { recursive: true });
  fs.writeFileSync(vendored, script);
  console.log(`wrote ${path.relative(repoRoot, vendored)} (${script.length} chars)`);
  process.exit(0);
}

if (!fs.existsSync(vendored)) fail(`no vendored copy at ${vendored}; run with --write to create it`);
const current = fs.readFileSync(vendored, 'utf8');
if (current === script) {
  console.log(`no drift: ${path.relative(repoRoot, vendored)} matches the SDK ${sdkVersion} bundle (plus local patches)`);
  process.exit(0);
}

console.log(`DRIFT: ${path.relative(repoRoot, vendored)} differs from the SDK ${sdkVersion} bundle\n`);
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-drift-')), `${name}.upstream.js`);
fs.writeFileSync(tmp, script);
const diff = spawnSync('diff', ['-u', vendored, tmp], { encoding: 'utf8' });
process.stdout.write(diff.stdout || diff.stderr || '(diff unavailable)\n');
console.log(`\nupstream copy left at ${tmp}. Review, then re-run with --write to adopt it.`);
process.exit(1);

function findBinary() {
  if (!fs.existsSync(sdkDir)) fail(`${sdkDir} missing — run npm ci in agent-container/ first`);
  const candidates = fs
    .readdirSync(sdkDir)
    .filter((d) => d.startsWith('claude-agent-sdk-'))
    .map((d) => path.join(sdkDir, d, 'claude'))
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) fail(`no claude-agent-sdk-<platform>/claude binary under ${sdkDir}`);
  return candidates[0];
}

function extract(buf, workflowName) {
  const startMarker = Buffer.from(`var i="${workflowName}",e=i,`);
  const start = buf.indexOf(startMarker);
  if (start < 0) fail(`no bundled workflow named "${workflowName}" in the binary (marker not found)`);
  const end = buf.indexOf(Buffer.from('export{'), start);
  if (end < 0) fail('chunk end marker not found');
  const chunk = buf.subarray(start, end).toString('utf8');
  const exportStmt = buf
    .subarray(end, end + 200)
    .toString('utf8')
    .match(/^export\{(\w+) as initBundledWorkflows\}/);
  if (!exportStmt) fail('chunk does not end with `export{<fn> as initBundledWorkflows}` — the bundle layout changed');

  const register = chunk.match(/(\w+)\(`export const meta/);
  if (!register) fail('registration call before `export const meta` not found — the bundle layout changed');

  // Stub every function the chunk calls but does not declare (feature-flag
  // lookups, the registrar, ...). Declared = `function X` / `var X`.
  const declared = new Set([...chunk.matchAll(/\b(?:function|var|let|const)\s+([\w$]+)/g)].map((m) => m[1]));
  const called = new Set([...chunk.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));
  const keywords = new Set(['if', 'for', 'while', 'return', 'function', 'switch', 'catch', 'typeof']);
  const captured = [];
  const sandbox = { JSON, captured };
  for (const id of called) {
    if (declared.has(id) || keywords.has(id) || id in globalThis) continue;
    sandbox[id] =
      id === register[1]
        ? (scriptText, metaObj) => captured.push({ script: scriptText, meta: metaObj })
        : () => false;
  }
  vm.runInNewContext(`${chunk};${exportStmt[1]}();`, sandbox, { timeout: 5000 });
  const hit = captured.find((c) => c.meta?.name === workflowName);
  if (!hit || typeof hit.script !== 'string') fail(`registration for "${workflowName}" was not captured`);
  return hit;
}

function applyLocalPatches(text, workflowName) {
  let out = text;
  for (const { from, to } of LOCAL_PATCHES[workflowName] ?? []) {
    const n = out.split(from).length - 1;
    if (n === 0) fail(`local patch no longer applies to upstream ${workflowName}: ${JSON.stringify(from)} - review LOCAL_PATCHES`);
    out = out.split(from).join(to);
    console.log(`local patch: ${JSON.stringify(from)} -> ${JSON.stringify(to)} (${n}x)`);
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fail(msg) {
  console.error(`extract-bundled-workflow: ${msg}`);
  process.exit(2);
}
