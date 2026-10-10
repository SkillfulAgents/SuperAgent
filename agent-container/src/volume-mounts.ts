import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { volumesEnvSchema, type ContainerMount } from './volume-mounts-schema';
import { createVolumeCache, preserveVolumeCache } from './volume-recovery';

const execFileAsync = promisify(execFile);

const MOUNTS_DIR = '/mounts';
const MOUNT_TIMEOUT_MS = 10_000;

let mounted: (ContainerMount & { rclone: ChildProcess; cache: string })[] = [];
let finished: Promise<{ drained: boolean; recovered: number; recoveryErrors: number }> | undefined;

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

export function rcloneMountArgs(volumeId: string, mountPath: string, hostApiUrl: string, cacheMode: ContainerMount['cacheMode'] = 'local', caseInsensitive = false, cacheDir = `/workspace/.volume-cache/${volumeId}`): string[] {
  return [
    // mount's bazil FUSE adapter caches newly created entries for a minute,
    // regardless of --attr-timeout. After a directory rename/refresh those
    // inodes can still refer to old VFS nodes. mount2 applies the configured
    // expiry to creates and lookups alike.
    'mount2', ':webdav:', mountPath,
    '--webdav-url', `${hostApiUrl}/volumes/${volumeId}`,
    // Plain WebDAV gives rclone no modification time, so a cached copy is checked against the app by size alone and a
    // same-size edit on the host is missed. The rclone vendor setting reads modification times. The app ignores the
    // X-OC-Mtime header it adds to uploads.
    '--webdav-vendor', 'rclone',
    // WebDAV defaults to case-sensitive. On Dropbox, rclone otherwise deletes
    // "FILE" as a separate destination before moving "file", deleting the source
    // itself. Keep Linux VFS lookups case-sensitive: making both spellings the
    // same inode lets the kernel silently skip a case-only rename.
    ...(caseInsensitive ? ['--disable', '!CaseInsensitive'] : []),
    // rclone waits 10ms between WebDAV requests by default, while the app answers in about 1ms, so git on a mount
    // ran 15x slower than through a bind mount. Not 0, so retries after a server error still back off. Retries
    // back off from that 1ms, so 13 of them ride out an app restart as long as the default 10 did from 10ms.
    '--webdav-pacer-min-sleep', '1ms', '--low-level-retries', '13',
    '--vfs-cache-mode', cacheMode === 'remote' ? 'full' : 'writes',
    '--cache-dir', cacheDir,
    // Remote reads benefit from a disk cache; keep its footprint bounded per mount.
    ...(cacheMode === 'remote' ? ['--vfs-cache-max-size', '512M', '--vfs-cache-max-age', '1h'] : []),
    // Reopening a file within the handle-caching window after its cached copy went stale reads zeros instead of
    // downloading the new contents.
    '--vfs-handle-caching', '0',
    // A directory move replaces VFS child nodes. Kernel-cached dentries can
    // still point at children with the old paths; resolve them through VFS on
    // each lookup. The VFS directory/read caches above still serve those calls.
    '--attr-timeout', '0s',
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

async function mountVolume(volume: ContainerMount): Promise<(ContainerMount & { rclone: ChildProcess; cache: string }) | undefined> {
  const { volumeId, name, cacheMode, caseInsensitive } = volume;
  const mountPath = path.join(MOUNTS_DIR, name);
  let rclone: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  try {
    await fs.promises.mkdir(mountPath, { recursive: true });
    const cache = await createVolumeCache(volume);
    const unmountedDev = (await fs.promises.stat(mountPath)).dev;
    const child = spawn('rclone', rcloneMountArgs(volumeId, mountPath, process.env.SUPERAGENT_HOST_API_URL ?? '', cacheMode, caseInsensitive, cache), {
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
    return { ...volume, rclone: child, cache };
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
  mounted = processes.filter((m): m is NonNullable<typeof m> => m !== undefined);
  finished = undefined;
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
  if (reply === undefined) return ['upload status unavailable'];
  const parsed = uploadQueueSchema.safeParse(reply);
  if (!parsed.success) {
    console.error('[volumes] Unexpected vfs/queue reply:', reply);
    return ['upload status unavailable'];
  }
  const { queue } = parsed.data;
  const waiting = queue.filter((u) => !u.uploading && u.expiry > 0);
  await Promise.all(waiting.map((u) => rc(volumeId, 'vfs/queue-set-expiry', { id: u.id, expiry: 0 })));
  return queue.map((u) => u.name);
}

// A closed file uploads in the background, and rclone drops that upload when stopped.
// Returns what was still pending once the deadline passes.
export async function waitForUploads(uploads: () => Promise<string[]>, deadline: number): Promise<string[]> {
  let pending: string[] = ['upload status not checked'];
  while (Date.now() < deadline) {
    // FUSE queues a file after close() has returned, so an answer right away can miss it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    pending = await uploads();
    if (pending.length === 0) return [];
  }
  return pending;
}

export async function drainVolumeUploads(deadline: number): Promise<boolean> {
  const queues = await Promise.all(mounted.map(({ volumeId }) => {
    let empty = 0;
    return waitForUploads(async () => {
      const queue = await startQueuedUploads(volumeId);
      empty = queue.length === 0 ? empty + 1 : 0;
      return empty >= 2 ? [] : queue.length ? queue : ['checking uploads'];
    }, deadline);
  }));
  return queues.every(queue => queue.length === 0);
}

export function finishVolumeStop(drained: boolean): Promise<{ drained: boolean; recovered: number; recoveryErrors: number }> {
  return finished ??= (async () => {
    const result = { drained, recovered: 0, recoveryErrors: 0 };
    await Promise.all(mounted.map(async ({ rclone, cache }) => {
      // Freeze the cache before moving it: a late upload must not remove the
      // preserved copy. Killing rclone also prevents any further FUSE writes.
      if (rclone.exitCode === null && rclone.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1_000);
          rclone.once('exit', () => { clearTimeout(timer); resolve(); });
          rclone.kill('SIGKILL');
        });
      }
      try {
        if (drained) await fs.promises.rm(cache, { recursive: true, force: true });
        else { await preserveVolumeCache(cache); result.recovered++; }
      } catch (error) {
        // The original cache is already durable in /workspace/.volume-cache.
        result.recoveryErrors++;
        console.error('[volumes] Could not finalize workspace cache:', error);
      }
    }));
    return result;
  })();
}

export async function unmountVolumes(deadline: number): Promise<void> {
  if (finished) { await finished; return; }
  const drained = await drainVolumeUploads(deadline);
  const result = await finishVolumeStop(drained);
  if (!result.drained) console.error('[volumes] Unfinished uploads preserved in the workspace:', result);
}

export function mountedVolumePaths(): string[] {
  return mounted.map((m) => path.join(MOUNTS_DIR, m.name));
}

export function mountedVolumeIds(): string[] {
  return mounted.map((m) => m.volumeId);
}
