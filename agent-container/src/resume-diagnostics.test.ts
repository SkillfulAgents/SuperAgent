import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetForeignDiagnostics, prepareResumeDiagnostics } from './resume-diagnostics';

const foreign = { type: 'assistant', requestId: 'req-router', uuid: 'entry-1', parentUuid: 'user-1', message: {
  id: 'gen-router', model: 'anthropic/claude-haiku-4.5', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo 42' } }],
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 30 },
}, timestamp: '2026-09-22T00:00:00Z' };
const direct = { ...foreign, requestId: 'req-direct', message: { ...foreign.message, id: 'msg_direct' } };
const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
let scratch: string;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe('resume diagnostic hints', () => {
  it('keeps identity, content, tools, usage, unknown metadata and valid Anthropic hints unchanged', () => {
    const original = jsonl({ type: 'user', requestId: 'user-request' }, foreign, direct) + '{partial';
    const actual = resetForeignDiagnostics(original);
    const { requestId: _, ...retained } = foreign;
    expect(actual).toBe(jsonl({ type: 'user', requestId: 'user-request' }, retained, direct) + '{partial');
    expect(resetForeignDiagnostics(actual)).toBe(actual);
  });

  it('touches only the resumed session and its subagents, including forks and hashed project paths', () => {
    scratch = mkdtempSync(join(tmpdir(), 'resume-diagnostics-'));
    const session = randomUUID();
    const other = randomUUID();
    const project = join(scratch, 'projects', 'sdk-encoded-path');
    const subagents = join(project, session, 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(project, session + '.jsonl'), jsonl(foreign));
    writeFileSync(join(project, other + '.jsonl'), jsonl(foreign));
    writeFileSync(join(subagents, 'agent-test.jsonl'), jsonl(foreign, direct));
    prepareResumeDiagnostics(session, scratch);
    expect(readFileSync(join(project, session + '.jsonl'), 'utf8')).toBe(resetForeignDiagnostics(jsonl(foreign)));
    expect(readFileSync(join(subagents, 'agent-test.jsonl'), 'utf8')).toBe(resetForeignDiagnostics(jsonl(foreign, direct)));
    expect(readFileSync(join(project, other + '.jsonl'), 'utf8')).toBe(jsonl(foreign));
    expect(readdirSync(project).some(name => name.endsWith('.tmp'))).toBe(false);
    expect(() => prepareResumeDiagnostics(session, scratch)).not.toThrow();
  });

  it('leaves missing and invalid sessions to the SDK without following paths', () => {
    scratch = mkdtempSync(join(tmpdir(), 'resume-diagnostics-'));
    expect(() => prepareResumeDiagnostics(randomUUID(), scratch)).not.toThrow();
    expect(() => prepareResumeDiagnostics('../outside', scratch)).not.toThrow();
  });
});
