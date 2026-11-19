import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const guide = readFileSync(resolve(__dirname, '../../docs/media-generation.md'), 'utf8');
const [list, schema, run, foregroundPoll] = [...guide.matchAll(/^`{3}bash\n([\s\S]*?)\n`{3}$/gm)].map((m) => m[1]);
const model = 'datalab-to/ocr';
const modelDetail = {
  owner: 'datalab-to', name: 'ocr',
  latest_version: { openapi_schema: { components: { schemas: {
    Output: { type: 'object', properties: {
      text: { type: 'string' },
      visualizations: { type: 'array', items: { $ref: '#/components/schemas/File' } },
    } },
    File: { type: 'string', format: 'uri' },
  } } } },
};

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'media-guide-'));
  // Exercise the real downloader. Every network response in this process is a fixture.
  writeFileSync(join(workspace, 'fetch.cjs'), `
    global.fetch = async (url, options) => {
      if (url.href !== 'https://replicate.delivery/asset.png' || options.redirect !== 'manual') {
        throw new Error('Unexpected file request: ' + url.href);
      }
      if (process.env.REDIRECT) return new Response(null, {status: 302, headers: {Location: process.env.REDIRECT}});
      return new Response(process.env.JOB_ID);
    };
  `);
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function bash(command: string, env: Record<string, string> = {}) {
  const example = command
    .replaceAll('/workspace', '"$WORKSPACE"')
    .replaceAll('fox-poster.REPLACE_ME', '"$RUN_NAME"')
    .replaceAll('PREDICTION_ID', '"$JOB_ID"')
    .replaceAll('{owner}/{name}', model)
    .replaceAll('node /app/dist/scripts/media-output.js', 'node -r "$MOCK_FETCH" -r "$TS_REGISTER" "$HELPER"');
  const mockApi = `
    curl() {
      if [ -n "$API_ERROR" ]; then return 22; fi
      case "$*" in
        *" -X POST "*) printf '%s' "$CREATE" ;;
        */predictions/*) printf '%s' "$RESULT" ;;
        *) printf '%s' "$MODEL" ;;
      esac
    }
    sleep() { :; }
  `;
  return spawnSync('bash', ['-c', mockApi + example], {
    encoding: 'utf8',
    env: {
      ...process.env, WORKSPACE: workspace, MODEL: JSON.stringify(modelDetail), API_ERROR: '', REDIRECT: '',
      PLATFORM_BASE_URL: 'https://platform.invalid', PLATFORM_AUTH_TOKEN: 'fixture',
      TS_REGISTER: require.resolve('ts-node/register/transpile-only'),
      TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.json'),
      HELPER: resolve(__dirname, 'media-output.ts'), MOCK_FETCH: join(workspace, 'fetch.cjs'),
      ...env,
    },
  });
}

function prepareRun(): string {
  const result = bash(schema);
  expect(result.status, result.stderr).toBe(0);
  const [line] = result.stdout.split('\n');
  expect(line).toMatch(/^Run directory /);
  return basename(line.slice('Run directory '.length));
}

function prediction(id: string, runName: string) {
  const result = { id, model, status: 'succeeded', input: { prompt: 'A printed page' }, output: {
    text: 'https://replicate.delivery/recognized-text.png',
    visualizations: ['https://replicate.delivery/asset.png', 'https://example.org/external.png'],
  } };
  return {
    RUN_NAME: runName, JOB_ID: id, CREATE: JSON.stringify({ id, model, status: 'starting' }),
    RESULT: JSON.stringify(result, null, 2),
  };
}

// Agent containers ship Bash and jq. A Windows developer may have neither.
describe.skipIf(spawnSync('bash', ['-c', 'command -v jq']).status !== 0)('media-generation guide', () => {
  it('propagates failed catalog and schema requests', () => {
    for (const command of [list, schema]) expect(bash(command, { API_ERROR: '403' }).status).not.toBe(0);
  });

  it('isolates predictions and saves only declared files from the service host', () => {
    const first = prepareRun();
    const second = prepareRun();
    expect(second).not.toBe(first);
    for (const [dir, id] of [[first, 'p1'], [second, 'p2'], [first, 'p3']]) {
      const result = bash(run, prediction(id, dir));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`bytes  ${join(workspace, dir, id, '1-asset.png')}`);
      expect(readdirSync(join(workspace, dir, id))).toEqual(['1-asset.png']);
    }
    expect(readFileSync(join(workspace, first, 'p1/1-asset.png'), 'utf8')).toBe('p1');
  });

  it('prints the same compact job in a foreground poll and an aborted run', () => {
    const env = prediction('job1', prepareRun());
    env.RESULT = JSON.stringify({ id: 'job1', model, status: 'aborted', error: 'Deadline', input: { prompt: 'Page' }, output: null }, null, 2);
    const launched = bash(run, env);
    expect(launched.status).toBe(1);
    const poll = bash(foregroundPoll, env);
    expect(poll.status, poll.stderr).toBe(1);
    expect(poll.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(poll.stdout)).toEqual(JSON.parse(env.RESULT));
    expect(launched.stdout.trim().split('\n').at(-1)).toBe(poll.stdout.trim());
  });

  it('leaves the prediction directory ready for recovery after a refused redirect', () => {
    const env = prediction('job2', prepareRun());
    const result = bash(run, { ...env, REDIRECT: 'https://example.org/elsewhere.png' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('redirected outside');
    expect(readdirSync(join(workspace, env.RUN_NAME, env.JOB_ID))).toEqual([]);
    const resumed = bash(foregroundPoll + '\nnode /app/dist/scripts/media-output.js save "${DIR%/*}" <<<"$P"', env);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(join(workspace, env.RUN_NAME, env.JOB_ID, '1-asset.png'), 'utf8')).toBe('job2');
  });
});
