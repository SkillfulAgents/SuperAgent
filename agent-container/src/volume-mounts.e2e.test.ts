/**
 * End-to-end volume mounts against the real agent image: the server boots,
 * mounts SUPERAGENT_VOLUMES with FUSE from a WebDAV server inside the
 * container, and holds /health until the mounts settle.
 *
 * Opt-in: needs Docker with /dev/fuse. Uses the app's FUSE permissions,
 * including its AppArmor override on Linux. Builds the image first.
 *   RUN_VOLUMES_E2E=1 npx vitest run src/volume-mounts.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

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
function startAgent(server: string, volumes: { volumeId: string; name: string; cacheMode?: 'local' | 'remote'; caseInsensitive?: boolean }[], user = 'claude', runArgs: string[] = []): string {
  const rootOnlyDevice = user === 'root' ? 'chmod 600 /dev/fuse; ' : '';
  const container = docker(
    'run', '-d', '--user', user, '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined', ...runArgs,
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

  it('remote mounts reuse listings and reads, then see external edits after expiry or refresh', async () => {
    const source = '/tmp/src/cloud';
    const file = '/mounts/cloud/w.txt';
    // Count WebDAV calls without changing rclone's real server/file behavior.
    const proxy = `
      const http = require('http');
      const counts = { GET: 0, PROPFIND: 0 };
      http.createServer((req, res) => {
        if (req.url === '/counts') { res.end(JSON.stringify(counts)); return; }
        if (req.method in counts) counts[req.method]++;
        const upstream = http.request({ hostname: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { res.statusCode = 502; res.end(); });
        req.pipe(upstream);
      }).listen(8080, '127.0.0.1');
    `;
    const quotedProxy = "'" + proxy.replace(/'/g, "'\\''") + "'";
    const container = startAgent(
      `mkdir -p ${source} && echo AAAAAAAA > ${source}/w.txt && chmod -R a+rwX /tmp/src && (rclone serve webdav /tmp/src --addr 127.0.0.1:8081 --baseurl /api/volumes --dir-cache-time 0s & node -e ${quotedProxy})`,
      [{ volumeId: 'cloud', name: 'cloud', cacheMode: 'remote' }],
    );
    await healthUntilOk(container);
    expect(sh(container, `cat ${file}`)).toBe('AAAAAAAA');
    const before = sh(container, 'curl -s 127.0.0.1:8080/counts');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(sh(container, `ls /mounts/cloud && cat ${file}`)).toBe('w.txt\nAAAAAAAA');
    expect(sh(container, 'curl -s 127.0.0.1:8080/counts')).toBe(before);

    sh(container, `echo BBBBBBBB > ${source}/w.txt`);
    expect(sh(container, `cat ${file}`)).toBe('AAAAAAAA');
    const invalidate = 'curl -sf --unix-socket /tmp/rclone-cloud.sock -X POST -H "Content-Type: application/json" -d "{}" http://rc/vfs/refresh';
    // Exercise the real five-minute policy, including the kernel and disk caches.
    await waitFor(() => sh(container, `ls /mounts/cloud >/dev/null && cat ${file}`) === 'BBBBBBBB', 305_000);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    sh(container, `echo CCCCCCCCCCCCCC > ${source}/w.txt`);
    sh(container, invalidate);
    await waitFor(() => sh(container, `ls /mounts/cloud >/dev/null && cat ${file}`) === 'CCCCCCCCCCCCCC', 4_000);

    sh(container, 'echo own-write > /mounts/cloud/new.txt');
    expect(sh(container, 'cat /mounts/cloud/new.txt')).toBe('own-write');
    await waitFor(() => sh(container, `cat ${source}/new.txt 2>/dev/null || true`) === 'own-write', 5_000);
  }, 340_000);

  it('remote mounts resolve newly created children after a directory rename and refresh', async () => {
    const source = '/tmp/src/cloud';
    const mount = '/mounts/cloud';
    const container = startAgent(
      `mkdir -p ${source} && chmod -R a+rwX /tmp/src && rclone serve webdav /tmp/src --addr 127.0.0.1:8080 --baseurl /api/volumes --dir-cache-time 0s`,
      [{ volumeId: 'cloud', name: 'cloud', cacheMode: 'remote' }],
    );
    await healthUntilOk(container);
    sh(container, `mkdir -p ${mount}/tree/a/b && echo original > ${mount}/tree/a/b/file`);
    await waitFor(() => sh(container, `cat ${source}/tree/a/b/file 2>/dev/null || true`) === 'original', 5_000);
    sh(container, `mv ${mount}/tree/a ${mount}/tree/moved`);
    expect(sh(container, `cat ${mount}/tree/moved/b/file`)).toBe('original');
    sh(container, `rm ${mount}/tree/moved/b/file`);
    expect(sh(container, `test ! -f ${source}/tree/moved/b/file && echo removed`)).toBe('removed');

    sh(container, `echo initial > ${mount}/fresh`);
    await waitFor(() => sh(container, `cat ${source}/fresh 2>/dev/null || true`) === 'initial', 5_000);
    expect(sh(container, `cat ${mount}/fresh`)).toBe('initial');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    sh(container, `echo replaced-and-longer > ${source}/fresh`);
    sh(container, 'curl -sf --unix-socket /tmp/rclone-cloud.sock -X POST -H "Content-Type: application/json" -d "{}" http://rc/vfs/refresh');
    expect(sh(container, `cat ${mount}/fresh`)).toBe('replaced-and-longer');
  }, 60_000);

  it('case-only rename retains the file when WebDAV resolves case aliases', async () => {
    // Emulate Dropbox's case-insensitive lookup over a real filesystem server.
    // Leave Destination untouched so MOVE preserves the requested spelling.
    const proxy = `
      const http = require('http'), fs = require('fs'), path = require('path');
      http.createServer((req, res) => {
        const parts = decodeURIComponent(req.url.split('?')[0]).split('/').filter(Boolean).slice(2);
        let current = '/tmp/src';
        const canonical = parts.map(part => {
          const entries = fs.existsSync(current) ? fs.readdirSync(current) : [];
          const match = entries.find(name => name === part) || entries.find(name => name.toLowerCase() === part.toLowerCase()) || part;
          current = path.join(current, match);
          return encodeURIComponent(match);
        });
        const target = '/api/volumes/' + canonical.join('/') + (req.url.endsWith('/') ? '/' : '');
        const upstream = http.request({ hostname: '127.0.0.1', port: 8081, path: target, method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode, response.headers); response.pipe(res);
        });
        upstream.on('error', () => { res.statusCode = 502; res.end(); });
        req.pipe(upstream);
      }).listen(8080, '127.0.0.1');
    `;
    const quoted = "'" + proxy.replace(/'/g, "'\\''") + "'";
    const container = startAgent(
      `mkdir -p /tmp/src/cloud && chmod -R a+rwX /tmp/src && (rclone serve webdav /tmp/src --addr 127.0.0.1:8081 --baseurl /api/volumes --dir-cache-time 0s & node -e ${quoted})`,
      [{ volumeId: 'cloud', name: 'cloud', cacheMode: 'remote', caseInsensitive: true }],
    );
    await healthUntilOk(container);
    sh(container, 'echo case-test > /mounts/cloud/lower.txt');
    await waitFor(() => sh(container, 'cat /tmp/src/cloud/lower.txt 2>/dev/null || true') === 'case-test', 5_000);
    sh(container, 'mv /mounts/cloud/lower.txt /mounts/cloud/LOWER.txt');
    expect(sh(container, 'ls /tmp/src/cloud')).toBe('LOWER.txt');
    expect(sh(container, 'cat /tmp/src/cloud/LOWER.txt')).toBe('case-test');
  }, 60_000);

  it('git sees no mode change in a mounted repo, and keeps the executable bit outside /mounts', async () => {
    // The repo is made on the source side, as on the host: a repo made through the mount would detect
    // that chmod does not stick and turn off core.fileMode itself.
    const source = '/tmp/src/v_git';
    const commit = 'git -c user.name=t -c user.email=t@t commit -qm init';
    const container = startAgent(
      `mkdir -p ${source} && cd ${source} && git init -q && echo x > a.txt && git add a.txt && ${commit} && chmod -R a+rwX /tmp/src && rclone serve webdav /tmp/src --addr 127.0.0.1:8080 --baseurl /api/volumes --dir-cache-time 0s`,
      [{ volumeId: 'v_git', name: 'repo' }],
    );
    await healthUntilOk(container);

    expect(sh(container, 'cd /mounts/repo && git --no-optional-locks status --porcelain')).toBe('');
    expect(sh(container, 'git --no-optional-locks --work-tree /mounts/repo -C /mounts/repo status --porcelain')).toBe('');
    expect(sh(container, `git -C ${source} config core.fileMode`)).toBe('true');

    sh(container, `cd /tmp && git init -q plain && cd plain && printf '#!/bin/sh\\n' > run.sh && chmod +x run.sh && git add run.sh`);
    expect(sh(container, 'git -C /tmp/plain ls-files -s run.sh').slice(0, 6)).toBe('100755');
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

  it.each(['local', 'remote', 'dead-rclone'] as const)('preserves unfinished %s uploads in the workspace after the container is removed', async mode => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-preserve-source-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-preserve-workspace-'));
    for (const dir of [source, workspace]) fs.chmodSync(dir, 0o777);
    try {
      const container = startAgent(
        'rclone serve webdav /srv --addr 127.0.0.1:8080 --baseurl /api/volumes --bwlimit 1M',
        [{ volumeId: 'v_preserve', name: 'docs', cacheMode: mode === 'local' ? 'local' : 'remote' }],
        'claude', ['-v', `${source}:/srv/v_preserve`, '-v', `${workspace}:/workspace`],
      );
      await healthUntilOk(container);
      sh(container, 'head -c 40000000 /dev/urandom > /mounts/docs/pending.bin');
      const expected = sh(container, 'sha256sum /mounts/docs/pending.bin').split(' ')[0];
      if (mode === 'dead-rclone') sh(container, "pkill -KILL -f '^rclone mount(2)? '");
      const started = Date.now();
      const result = JSON.parse(sh(container, 'curl -sf -X POST localhost:3000/volumes/prepare-stop'));
      expect(result).toEqual({ drained: false, recovered: 1, recoveryErrors: 0 });
      expect(Date.now() - started).toBeLessThan(20_000);
      docker('stop', '-t', '5', container);
      docker('rm', container);
      const root = path.join(workspace, 'recovered-volume-uploads');
      const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' });
      const saved = files.find(file => file.includes('/vfs/') && file.endsWith('/pending.bin'))!;
      const bytes = fs.readFileSync(path.join(root, saved));
      expect(bytes.length).toBe(40_000_000);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
      expect(files.some(file => file.includes('/vfsMeta/') && file.endsWith('/pending.bin'))).toBe(true);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
