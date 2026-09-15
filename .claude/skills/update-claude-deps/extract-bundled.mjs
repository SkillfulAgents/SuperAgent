#!/usr/bin/env node
// Extract the pieces of the Claude Code CLI that we vendor into the Gamut
// plugin (agent-container/plugin/) and diff them against the vendored copies.
//
// Why: agent-container sets `disableBundledSkills: true`, which hides every
// skill and workflow bundled in the CLI, and vendors the ones we still want.
// Those copies stop tracking upstream, so every SDK bump must re-extract and
// diff them. See .claude/skills/update-claude-deps/SKILL.md (validation step 5).
//
// Usage (from the repo root, after `npm ci` in agent-container/):
//   node .claude/skills/update-claude-deps/extract-bundled.mjs                 # check all, exit 1 on drift
//   node .claude/skills/update-claude-deps/extract-bundled.mjs --write         # adopt upstream for all
//   node .claude/skills/update-claude-deps/extract-bundled.mjs --only <name>   # one entry
//
// How: the CLI is a single bun-compiled binary whose JS chunks are embedded as
// text. Each chunk starts with a `// Version: x.y.z` banner and ends with an
// `export{...}` statement. We locate the chunk that holds what we want, stub
// the identifiers it imports, run it in a vm and capture the result.
//   - workflow: the bundled-workflows chunk declares each workflow as
//     `var i="<name>",e=i,t="<description>",...` and registers it with the
//     script as a template literal.
//   - skill: a registration chunk (found by its menuDescription) names the
//     function that returns the prompt text; that function lives in another
//     chunk, which we find by its export list and evaluate with the constants
//     it imports resolved from the binary (tool names, limits) — an identifier
//     we cannot resolve fails loudly rather than rendering a wrong value.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Everything we vendor. `patches` are deliberate local edits applied to the
// upstream text before it is compared or written — tiny and mechanical, and
// each must still match upstream or the extractor fails (exit 2) so a human
// looks. `constants` pins an imported identifier the resolver cannot find.
const VENDORED = [
  {
    kind: 'workflow',
    name: 'deep-research',
    file: 'workflows/deep-research.js',
    // A plugin workflow is addressed as `<plugin>:<name>`, so the usage hint
    // the script prints when called without a question must say
    // `gamut:deep-research`. (`meta.name` stays bare — the CLI adds the prefix.)
    patches: [{ from: "Workflow({name: 'deep-research'", to: "Workflow({name: 'gamut:deep-research'" }],
  },
  {
    kind: 'skill',
    name: 'workflow-authoring',
    file: 'skills/workflow-authoring/SKILL.md',
    // The registration is found by this string; it names the prompt function.
    anchor: 'menuDescription:"Load the reference for writing Workflow tool scripts"',
    patches: [],
    constants: {},
  },
];

const args = process.argv.slice(2);
const write = args.includes('--write');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
if (onlyIdx >= 0 && !only) fail('--only needs a value');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sdkDir = path.join(repoRoot, 'agent-container', 'node_modules', '@anthropic-ai');
const pluginDir = path.join(repoRoot, 'agent-container', 'plugin');

const binary = findBinary();
const sdkVersion = readJson(path.join(sdkDir, 'claude-agent-sdk', 'package.json')).version;
console.log(`SDK ${sdkVersion} · ${path.relative(repoRoot, binary)}`);
const buf = fs.readFileSync(binary);
const text = buf.toString('latin1'); // byte-faithful view for regex scans; slices are re-decoded as utf8

let drifted = 0;
for (const entry of VENDORED) {
  if (only && entry.name !== only) continue;
  console.log(`\n== ${entry.kind} ${entry.name}`);
  const upstream = entry.kind === 'workflow' ? extractWorkflow(entry) : extractSkill(entry);
  const content = applyPatches(upstream, entry);
  const vendored = path.join(pluginDir, entry.file);
  const rel = path.relative(repoRoot, vendored);

  if (write) {
    fs.mkdirSync(path.dirname(vendored), { recursive: true });
    fs.writeFileSync(vendored, content);
    console.log(`wrote ${rel} (${content.length} chars)`);
    continue;
  }
  if (!fs.existsSync(vendored)) fail(`no vendored copy at ${rel}; run with --write to create it`);
  if (fs.readFileSync(vendored, 'utf8') === content) {
    console.log(`no drift: ${rel} matches the SDK ${sdkVersion} bundle${entry.patches.length ? ' (plus local patches)' : ''}`);
    continue;
  }
  drifted++;
  console.log(`DRIFT: ${rel} differs from the SDK ${sdkVersion} bundle\n`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-drift-')), path.basename(entry.file));
  fs.writeFileSync(tmp, content);
  const diff = spawnSync('diff', ['-u', vendored, tmp], { encoding: 'utf8' });
  process.stdout.write(diff.stdout || diff.stderr || '(diff unavailable)\n');
  console.log(`\nupstream copy left at ${tmp}. Review, then re-run with --write to adopt it.`);
}
process.exit(drifted ? 1 : 0);

// ---------------------------------------------------------------------------

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

/** Bounds of the JS chunk containing byte offset `at`: from its `// Version:` banner to its final `export{...}`. */
function chunkAt(at) {
  const start = text.lastIndexOf('// Version: ', at);
  if (start < 0) fail(`no chunk banner before offset ${at}`);
  const exp = text.indexOf('export{', at);
  const end = exp < 0 ? -1 : text.indexOf('}', exp);
  if (exp < 0 || end < 0) fail(`no export statement after offset ${at}`);
  return { start, end: end + 1, source: buf.subarray(start, end + 1).toString('utf8') };
}

/** `import{a,b as c}from"..."` statements → local identifier names. */
function importedIdentifiers(source) {
  const ids = new Set();
  for (const m of source.matchAll(/import\{([^}]*)\}from"[^"]+"/g)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop();
      if (local) ids.add(local);
    }
  }
  return ids;
}

/** Strip the banner and import statements so a chunk can run in a bare vm context. */
function chunkBody(source) {
  return source
    .replace(/^[\s\S]*?\/\/ Version: [^\n]*\n?/, '')
    .replace(/import(?:\{[^}]*\}from|\s+[\w$]+\s+from|\s*)"[^"]+";/g, '') // named, default and bare side-effect imports
    .replace(/export\{[^}]*\}\s*$/, '');
}

/**
 * Value of an exported constant: the one chunk that exports `id` (directly or
 * as `local as id`) and declares it as a string/number literal. Ambiguity or
 * absence returns undefined so the caller can decide.
 */
function resolveConstant(id) {
  const found = [];
  const exportRe = /export\{([^}]*)\}/g;
  for (const m of text.matchAll(exportRe)) {
    const names = m[1].split(',').map((s) => s.trim());
    let local = null;
    for (const n of names) {
      const parts = n.split(/\s+as\s+/);
      if (parts.length === 2 && parts[1] === id) local = parts[0];
      else if (parts.length === 1 && parts[0] === id) local = id;
    }
    if (!local) continue;
    const chunkStart = text.lastIndexOf('// Version: ', m.index);
    const chunk = text.slice(chunkStart, m.index);
    const decl = chunk.match(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}=("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?)(?=[,;])`));
    if (decl) found.push(decl[1]);
  }
  if (found.length !== 1) return undefined;
  const lit = found[0];
  return lit.startsWith('"') ? JSON.parse(Buffer.from(lit, 'latin1').toString('utf8')) : Number(lit);
}

/** Sandbox with every imported identifier stubbed: constants resolved from the binary, objects as {}, functions as () => false. */
function sandboxFor(source, entry, extra = {}) {
  const sandbox = { JSON, ...extra };
  for (const id of importedIdentifiers(source)) {
    if (id in sandbox) continue;
    if (entry.constants && id in entry.constants) {
      sandbox[id] = entry.constants[id];
    } else if (new RegExp(`(?<![\\w$])${id.replace(/\$/g, '\\$')}\\.`).test(source)) {
      sandbox[id] = {}; // used as an object (process.env-style lookups) — absent keys are fine
    } else if (new RegExp(`(?<![\\w$])${id.replace(/\$/g, '\\$')}\\(`).test(source)) {
      sandbox[id] = () => false; // feature-flag / gate call
    } else {
      const value = resolveConstant(id);
      if (value === undefined) fail(`${entry.name}: cannot resolve imported identifier "${id}" to a literal — pin it under constants: {} in VENDORED`);
      sandbox[id] = value;
      console.log(`resolved ${id} = ${JSON.stringify(value)}`);
    }
  }
  return sandbox;
}

function extractWorkflow(entry) {
  const start = text.indexOf(`var i="${entry.name}",e=i,`);
  if (start < 0) fail(`no bundled workflow named "${entry.name}" in the binary (marker not found)`);
  const { source } = chunkAt(start);
  if (!/export\{\w+ as initBundledWorkflows\}\s*$/.test(source)) fail('bundled-workflows chunk does not end with `export{<fn> as initBundledWorkflows}` — the bundle layout changed');
  const init = source.match(/export\{(\w+) as initBundledWorkflows\}/)[1];
  const register = source.match(/(\w+)\(`export const meta/);
  if (!register) fail('registration call before `export const meta` not found — the bundle layout changed');

  const captured = [];
  const sandbox = sandboxFor(source, entry, {
    captured,
    [register[1]]: (script, meta) => captured.push({ script, meta }),
  });
  vm.runInNewContext(`${chunkBody(source)};${init}();`, sandbox, { timeout: 5000 });
  const hit = captured.find((c) => c.meta?.name === entry.name);
  if (!hit || typeof hit.script !== 'string') fail(`registration for workflow "${entry.name}" was not captured`);
  console.log(`upstream: ${hit.meta.description}`);
  return hit.script;
}

function extractSkill(entry) {
  const at = text.indexOf(entry.anchor);
  if (at < 0) fail(`skill "${entry.name}" registration anchor not found: ${entry.anchor}`);
  const reg = chunkAt(at);
  const wrapper = reg.source.match(/getPromptForCommand\(\)\{return (\w+)\(\)\}/);
  if (!wrapper) fail(`${entry.name}: getPromptForCommand shape changed`);
  const bodyFn = reg.source.match(new RegExp(`function ${wrapper[1]}\\(\\)\\{return\\[\\{type:"text",text:(\\w+)\\(\\)\\}\\]\\}`));
  if (!bodyFn) fail(`${entry.name}: prompt wrapper shape changed`);
  const descM = reg.source.match(/description:`((?:[^`\\]|\\.)*)`/);
  if (!descM) fail(`${entry.name}: description template not found`);
  const description = vm.runInNewContext('`' + descM[1] + '`', sandboxFor(reg.source, entry));

  // The body function lives in another chunk: the one that both defines and exports it.
  const fn = bodyFn[1];
  const candidates = [];
  const defRe = new RegExp(`function ${fn}\\(\\)\\{`, 'g');
  for (const m of text.matchAll(defRe)) {
    const c = chunkAt(m.index);
    if (new RegExp(`export\\{[^}]*(?<![\\w$])${fn}(?![\\w$])[^}]*\\}\\s*$`).test(c.source)) candidates.push(c);
  }
  if (candidates.length !== 1) fail(`${entry.name}: expected exactly one chunk defining and exporting ${fn}(), found ${candidates.length}`);
  const body = candidates[0];
  const sandbox = sandboxFor(body.source, entry);
  const promptText = vm.runInNewContext(`${chunkBody(body.source)};${fn}();`, sandbox, { timeout: 5000 });
  if (typeof promptText !== 'string' || promptText.length < 500) fail(`${entry.name}: prompt text not captured`);
  console.log(`upstream: ${description}`);
  return `---\nname: ${entry.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${promptText.trim()}\n`;
}

function applyPatches(content, entry) {
  let out = content;
  for (const { from, to } of entry.patches ?? []) {
    const n = out.split(from).length - 1;
    if (n === 0) fail(`local patch no longer applies to upstream ${entry.name}: ${JSON.stringify(from)} — review VENDORED patches`);
    out = out.split(from).join(to);
    console.log(`local patch: ${JSON.stringify(from)} -> ${JSON.stringify(to)} (${n}x)`);
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fail(msg) {
  console.error(`extract-bundled: ${msg}`);
  process.exit(2);
}
