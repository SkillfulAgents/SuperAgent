/**
 * End-to-end volume mounts against the real agent image: the server boots,
 * mounts SUPERAGENT_VOLUMES with FUSE from a WebDAV server inside the
 * container, and holds /health until the mounts settle.
 *
 * Opt-in: needs Docker with /dev/fuse (Docker Desktop works; a Linux host's
 * AppArmor profile may block the mount). Builds the image first.
 *   RUN_VOLUMES_E2E=1 npx vitest run src/volume-mounts.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ENABLED = process.env.RUN_VOLUMES_E2E === '1';
const IMAGE = 'superagent-volumes-e2e';
const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const containers: string[] = [];

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
}

// As claude, who owns the FUSE mounts: root cannot see into them.
function sh(container: string, script: string): string {
  return docker('exec', '--user', 'claude', container, 'bash', '-c', script);
}

// Starts the agent through the image's start script after a 1s head start for
// `server` (a shell command for the test's app on :8080). As root, /dev/fuse is
// first made root-only, as on Apple Container, and the script opens it and drops to claude.
function startAgent(server: string, volumes: { volumeId: string; name: string }[], user = 'claude', runArgs: string[] = []): string {
  const rootOnlyDevice = user === 'root' ? 'chmod 600 /dev/fuse; ' : '';
  const container = docker(
    'run', '-d', '--user', user, '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', ...runArgs,
    '-e', `SUPERAGENT_VOLUMES=${JSON.stringify(volumes)}`,
    '-e', 'SUPERAGENT_HOST_API_URL=http://127.0.0.1:8080/api',
    '-e', 'PROXY_TOKEN=test-token',
    IMAGE, 'bash', '-c', `${rootOnlyDevice}${server} & sleep 1; exec gamut-start`,
  );
  containers.push(container);
  return container;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not true within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function healthVolumes(container: string): string[] {
  return JSON.parse(sh(container, 'curl -s localhost:3000/health')).volumes;
}

// Every /health status seen until it answers 200.
async function healthUntilOk(container: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await waitFor(() => {
    const code = sh(container, 'curl -s -o /dev/null -w "%{http_code}" localhost:3000/health || true');
    seen.add(code);
    return code === '200';
  }, 30_000);
  return seen;
}

describe.skipIf(!ENABLED)('volume mounts in the agent image', () => {
  beforeAll(() => {
    execFileSync('docker', ['build', '-t', IMAGE, CONTEXT], { stdio: 'ignore', timeout: 900_000 });
  }, 900_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore', timeout: 60_000 });
  }, 60_000);

  it.each(['claude', 'root'])('started as %s, mounts a served volume, and every file operation reaches the source', async (user) => {
    const source = '/tmp/src/v_good';
    const mount = '/mounts/docs';
    const container = startAgent(
      `mkdir -p ${source} && echo hello > ${source}/a.txt && chmod -R a+rwX /tmp/src && rclone serve webdav /tmp/src --addr 127.0.0.1:8080 --baseurl /api/volumes --dir-cache-time 0s`,
      [{ volumeId: 'v_good', name: 'docs' }],
      user,
    );
    await healthUntilOk(container);
    expect(sh(container, 'stat -c %U /proc/1')).toBe('claude');
    expect(healthVolumes(container)).toEqual(['v_good']);

    expect(sh(container, `ls ${mount}`)).toBe('a.txt');
    expect(sh(container, `stat -c %s ${mount}/a.txt`)).toBe('6');
    expect(sh(container, `cat ${mount}/a.txt`)).toBe('hello');

    sh(container, `printf '#!/bin/sh\\necho ran\\n' > ${mount}/run.sh`);
    expect(sh(container, `${mount}/run.sh`)).toBe('ran');
    sh(container, `rm ${mount}/run.sh`);

    sh(container, `echo more >> ${mount}/a.txt`);
    await waitFor(() => sh(container, `cat ${source}/a.txt`) === 'hello\nmore', 5_000);

    sh(container, `mkdir ${mount}/d && mv ${mount}/a.txt ${mount}/d/b.txt`);
    await waitFor(() => sh(container, `ls ${source}`) === 'd' && sh(container, `ls ${source}/d`) === 'b.txt', 5_000);

    sh(container, `rm ${mount}/d/b.txt && rmdir ${mount}/d`);
    await waitFor(() => sh(container, `ls -A ${source}`) === '', 5_000);

    // Git and editors write a temp file and rename it at once.
    sh(container, `cd ${mount} && node -e "const fs = require('fs'); for (const i of [1, 2, 3]) { fs.writeFileSync('tmp' + i, String(i)); fs.renameSync('tmp' + i, 'final' + i) }"`);
    await waitFor(() => sh(container, `ls ${source}`) === 'final1\nfinal2\nfinal3' && sh(container, `cat ${source}/final*`) === '123', 5_000);
    sh(container, `rm ${mount}/final*`);
    await waitFor(() => sh(container, `ls -A ${source}`) === '', 5_000);

    sh(container, `echo outside > ${source}/new.txt`);
    await waitFor(() => sh(container, `cat ${mount}/new.txt 2>/dev/null || true`) === 'outside', 2_000);
  }, 60_000);

  it('reads what the host wrote over a file the agent wrote, at the same size and after a resize', async () => {
    // In a folder: the kernel keeps an entry rclone creates for 60s without asking again, unless its folder is reread.
    const source = '/tmp/src/v_edit/sub';
    const file = '/mounts/docs/sub/w.txt';
    const container = startAgent(
      `mkdir -p ${source} && chmod -R a+rwX /tmp/src && rclone serve webdav /tmp/src --addr 127.0.0.1:8080 --baseurl /api/volumes --dir-cache-time 0s`,
      [{ volumeId: 'v_edit', name: 'docs' }],
    );
    await healthUntilOk(container);
    sh(container, `echo AAAAAAAA > ${file}`);
    await waitFor(() => sh(container, `cat ${source}/w.txt 2>/dev/null || true`) === 'AAAAAAAA', 5_000);
    // Modification times have 1s precision, so the host edit lands in a later second than the upload.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    sh(container, `echo BBBBBBBB > ${source}/w.txt`);
    await waitFor(() => sh(container, `cat ${file}`) === 'BBBBBBBB', 4_000);

    // The read above closed the file, so this read reopens it within rclone's default 5s handle-caching window.
    sh(container, `echo CCCCCCCCCCCCCC > ${source}/w.txt`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(sh(container, `cat ${file}`)).toBe('CCCCCCCCCCCCCC');
  }, 60_000);

  it('sends the token, leaves out a volume whose app never answers, and the container still removes at once', async () => {
    const booted = Date.now();
    const container = startAgent(
      `node -e "require('http').createServer((req) => console.log(req.headers.authorization)).listen(8080)"`,
      [{ volumeId: 'v_hang', name: 'stuck' }],
    );
    expect(await healthUntilOk(container)).toContain('503');
    expect(Date.now() - booted).toBeGreaterThanOrEqual(10_000);
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 60_000 });
    expect(logs.stdout).toContain('Bearer test-token');
    expect(logs.stderr).toContain('mount timed out');
    expect(sh(container, 'mountpoint -q /mounts/stuck && echo mounted || echo unmounted')).toBe('unmounted');
    expect(healthVolumes(container)).toEqual([]);

    const started = Date.now();
    docker('rm', '-f', container);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it('finishes an upload still running when the host stops the container', async () => {
    // The source lives on the host, so it outlives the container. The app is slowed so the upload outlasts the write.
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-src-'));
    fs.chmodSync(source, 0o777);
    const container = startAgent(
      'rclone serve webdav /srv --addr 127.0.0.1:8080 --baseurl /api/volumes --bwlimit 20M',
      [{ volumeId: 'v_slow', name: 'docs' }],
      'claude',
      ['-v', `${source}:/srv/v_slow`],
    );
    await healthUntilOk(container);
    sh(container, 'head -c 40000000 /dev/urandom > /mounts/docs/big.bin');
    const uploaded = path.join(source, 'big.bin');
    expect(fs.existsSync(uploaded) ? fs.statSync(uploaded).size : 0).toBeLessThan(40_000_000);

    // As the host stops it: 5s to exit, then removed.
    docker('stop', '-t', '5', container);
    // 0, not 137: shutdown finished on its own rather than being killed at 5s.
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', container)).toBe('0');
    docker('rm', container);
    expect(fs.statSync(uploaded).size).toBe(40_000_000);
    fs.rmSync(source, { recursive: true });
  }, 60_000);

  it('uploads a file still waiting in the queue when the host stops the container', async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-src-'));
    fs.chmodSync(source, 0o777);
    const container = startAgent('rclone serve webdav /srv --addr 127.0.0.1:8080 --baseurl /api/volumes', [{ volumeId: 'v_late', name: 'docs' }], 'claude', ['-v', `${source}:/srv/v_late`]);
    await healthUntilOk(container);
    // Holds the upload past the stop deadline, as a retry backing off after a failed upload would.
    const rc = 'curl -s --unix-socket /tmp/rclone-v_late.sock -X POST -H "Content-Type: application/json"';
    sh(container, `echo late > /mounts/docs/late.txt && sleep 0.2 && id=$(${rc} -d '{}' http://rc/vfs/queue | node -pe "JSON.parse(require('fs').readFileSync(0)).queue[0].id") && ${rc} -d "{\\"id\\":$id,\\"expiry\\":60}" http://rc/vfs/queue-set-expiry`);
    expect(fs.existsSync(path.join(source, 'late.txt'))).toBe(false);

    docker('stop', '-t', '5', container);
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', container)).toBe('0');
    docker('rm', container);
    expect(fs.readFileSync(path.join(source, 'late.txt'), 'utf8')).toBe('late\n');
    fs.rmSync(source, { recursive: true });
  }, 60_000);
});
