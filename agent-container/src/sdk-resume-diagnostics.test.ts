/** Real CLI/request regression: a mocked SDK cannot expose diagnostic ID reuse. */
import { afterEach, expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareResumeDiagnostics } from './resume-diagnostics';

let server: Server;
let scratch: string;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

it('resumes genuine SDK foreign-ID history without sending that ID to Anthropic diagnostics', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'sdk-resume-diagnostics-'));
  const configDir = join(scratch, 'config');
  let direct = false;
  const requests: Array<{ diagnostics?: { previous_message_id: string | null }; messages: unknown[] }> = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('/messages')) { res.end('{}'); return; }
    const body = JSON.parse(raw);
    requests.push(body);
    if (direct && body.diagnostics?.previous_message_id?.startsWith('gen-')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'diagnostics.previous_message_id: must start with msg_' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': direct ? 'req-direct' : 'req-router' });
    const events = [
      ['message_start', { type: 'message_start', message: { id: direct ? 'msg_direct' : 'gen-router', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Remember 84723' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  let sessionId: string | undefined;
  async function turn() {
    const env = { ...process.env, CLAUDECODE: '', CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: 'mock-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      // Exercise the CLI's first-party diagnostic request builder locally.
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: direct ? '1' : '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const q = query({ prompt: 'Remember 84723', options: { cwd: scratch, env, model: 'claude-haiku-4-5', tools: [], settingSources: [], maxTurns: 1, resume: sessionId, thinking: { type: 'disabled' } } });
    for await (const message of q) {
      if ('session_id' in message) sessionId = message.session_id;
      if (message.type === 'result' && message.is_error) throw new Error('CLI returned an API error');
    }
  }
  await turn();
  const project = join(configDir, 'projects', readdirSync(join(configDir, 'projects'))[0]);
  const transcript = join(project, sessionId + '.jsonl');
  const foreignMessages = () => readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === 'assistant' && row.message.id === 'gen-router');
  const before = foreignMessages();
  expect(before.length).toBeGreaterThan(0);
  expect(before[0].requestId).toBe('req-router');
  direct = true;
  // Prove the mock endpoint catches the actual SDK bug before applying the fix.
  await expect(turn()).rejects.toThrow();
  expect(requests.at(-1)?.diagnostics?.previous_message_id).toBe('gen-router');
  prepareResumeDiagnostics(sessionId!, configDir);
  await turn();
  expect(requests.at(-1)?.diagnostics).toEqual({ previous_message_id: null });
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Remember 84723');
  for (const row of before) {
    const after = foreignMessages().find(candidate => candidate.uuid === row.uuid);
    const { requestId: _, ...preserved } = row;
    expect(after).toEqual(preserved);
  }
  await turn();
  expect(requests.at(-1)?.diagnostics).toEqual({ previous_message_id: 'msg_direct' });
}, 60_000);
