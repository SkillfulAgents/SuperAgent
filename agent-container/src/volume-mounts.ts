import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { volumesEnvSchema, type ContainerMount } from './volume-mounts-schema';

const execFileAsync = promisify(execFile);

const MOUNTS_DIR = '/mounts';
const MOUNT_TIMEOUT_MS = 10_000;

let mounted: (ContainerMount & { rclone: ChildProcess })[] = [];

export function parseVolumes(raw: string | undefined): ContainerMount[] {
  if (!raw) return [];
  try {
    return volumesEnvSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.error('[volumes] Ignoring invalid SUPERAGENT_VOLUMES:', error);
    return [];
  }
}

function controlSocket(volumeId: string): string {
  return `/tmp/rclone-${volumeId}.sock`;
}

export function rcloneMountArgs(volumeId: string, mountPath: string, hostApiUrl: string, cacheMode: ContainerMount['cacheMode'] = 'local'): string[] {
  return [
    'mount', ':webdav:', mountPath,
    '--webdav-url', `${hostApiUrl}/volumes/${volumeId}`,
    // Plain WebDAV gives rclone no modification time, so a cached copy is checked against the app by size alone and a
    // same-size edit on the host is missed. The rclone vendor setting reads modification times. The app ignores the
    // X-OC-Mtime header it adds to uploads.
    '--webdav-vendor', 'rclone',
    // rclone waits 10ms between WebDAV requests by default, while the app answers in about 1ms, so git on a mount
    // ran 15x slower than through a bind mount. Not 0, so retries after a server error still back off. Retries
    // back off from that 1ms, so 13 of them ride out an app restart as long as the default 10 did from 10ms.
    '--webdav-pacer-min-sleep', '1ms', '--low-level-retries', '13',
    '--vfs-cache-mode', cacheMode === 'remote' ? 'full' : 'writes',
    // Remote reads benefit from a disk cache; keep its footprint bounded per mount.
    ...(cacheMode === 'remote' ? ['--vfs-cache-max-size', '512M', '--vfs-cache-max-age', '1h'] : []),
    // Reopening a file within the handle-caching window after its cached copy went stale reads zeros instead of
    // downloading the new contents.
    '--vfs-handle-caching', '0',
    // Every upload goes through rclone's queue, so a rename made right after close (as git and editors do) carries onto it.
    '--vfs-write-back', '1s',
    // Local edits must appear promptly; remote listings are expensive. Writes through
    // this mount invalidate its cache, while outside changes appear after expiry.
    '--dir-cache-time', cacheMode === 'remote' ? '5m' : '1s',
    // WebDAV keeps no file mode and rclone ignores chmod, so every file is executable, or no script could run.
    '--file-perms', '0777',
    // Shutdown reads the upload queue through this socket and starts what is waiting. Any claude process can use it,
    // including to quit rclone, which claude can already do by killing it.
    '--rc', '--rc-addr', `unix://${controlSocket(volumeId)}`, '--rc-no-auth',
  ];
}

export async function untilMountAnswers(mountPath: string, unmountedDev: number, settled: () => boolean): Promise<void> {
  while ((await fs.promises.stat(mountPath)).dev === unmountedDev) {
    if (settled()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The mount exists even when the app is unreachable. Listing it proves the app answers and accepts the token.
  await fs.promises.readdir(mountPath);
}

async function mountVolume({ volumeId, name, cacheMode }: ContainerMount): Promise<ChildProcess | undefined> {
  const mountPath = path.join(MOUNTS_DIR, name);
  let rclone: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  try {
    await fs.promises.mkdir(mountPath, { recursive: true });
    const unmountedDev = (await fs.promises.stat(mountPath)).dev;
    const child = spawn('rclone', rcloneMountArgs(volumeId, mountPath, process.env.SUPERAGENT_HOST_API_URL ?? '', cacheMode), {
      env: { ...process.env, RCLONE_WEBDAV_BEARER_TOKEN: process.env.PROXY_TOKEN },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    rclone = child;
    await Promise.race([
      untilMountAnswers(mountPath, unmountedDev, () => settled),
      new Promise((_, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`rclone exited with code ${code}`)));
        timer = setTimeout(() => reject(new Error('mount timed out')), MOUNT_TIMEOUT_MS);
      }),
    ]);
    return child;
  } catch (error) {
    console.error(`[volumes] Leaving out ${mountPath}:`, error);
    rclone?.kill();
    await execFileAsync('fusermount3', ['-uz', mountPath]).catch(() => {});
    return undefined;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

export async function mountVolumes(mounts: ContainerMount[]): Promise<void> {
  const processes = await Promise.all(mounts.map(mountVolume));
  mounted = mounts.flatMap((m, i) => {
    const rclone = processes[i];
    return rclone ? [{ ...m, rclone }] : [];
  });
}

function rc(volumeId: string, command: string, params: object = {}): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: controlSocket(volumeId), path: `/${command}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
      res.on('error', () => resolve(undefined));
    });
    // No answer means rclone is gone.
    req.on('error', () => resolve(undefined));
    req.end(JSON.stringify(params));
  });
}

const uploadQueueSchema = z.object({
  queue: z.array(z.object({ id: z.number(), name: z.string(), expiry: z.number(), uploading: z.boolean() })),
});

// Starts every waiting upload now rather than after the write-back delay, and returns all still queued or uploading.
async function startQueuedUploads(volumeId: string): Promise<string[]> {
  const reply = await rc(volumeId, 'vfs/queue');
  // A gone rclone has nothing left to upload.
  if (reply === undefined) return [];
  const parsed = uploadQueueSchema.safeParse(reply);
  if (!parsed.success) {
    console.error('[volumes] Unexpected vfs/queue reply:', reply);
    return [];
  }
  const { queue } = parsed.data;
  const waiting = queue.filter((u) => !u.uploading && u.expiry > 0);
  await Promise.all(waiting.map((u) => rc(volumeId, 'vfs/queue-set-expiry', { id: u.id, expiry: 0 })));
  return queue.map((u) => u.name);
}

// A closed file uploads in the background, and rclone drops that upload when stopped.
// Returns what was still pending once the deadline passes.
export async function waitForUploads(uploads: () => Promise<string[]>, deadline: number): Promise<string[]> {
  let pending: string[] = [];
  while (Date.now() < deadline) {
    // FUSE queues a file after close() has returned, so an answer right away can miss it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    pending = await uploads();
    if (pending.length === 0) return [];
  }
  return pending;
}

export async function unmountVolumes(deadline: number): Promise<void> {
  await Promise.all(mounted.map(async ({ volumeId, name, rclone }) => {
    const pending = await waitForUploads(() => startQueuedUploads(volumeId), deadline);
    if (pending.length > 0) console.error(`[volumes] Unmounting /mounts/${name} with uploads unfinished:`, pending);
    // SIGTERM makes rclone unmount.
    const exited = new Promise((resolve) => rclone.once('exit', resolve));
    rclone.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  }));
}

export function mountedVolumePaths(): string[] {
  return mounted.map((m) => path.join(MOUNTS_DIR, m.name));
}

export function mountedVolumeIds(): string[] {
  return mounted.map((m) => m.volumeId);
}
