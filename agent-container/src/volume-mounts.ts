import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const MOUNTS_DIR = '/mounts';
const MOUNT_TIMEOUT_MS = 10_000;

// Each name becomes one folder under /mounts, so it must be a single path segment.
const volumesEnvSchema = z.array(
  z.object({
    volumeId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().min(1).refine((name) => name !== '.' && name !== '..' && !/[/\0]/.test(name)),
  }),
);

type ContainerMount = z.infer<typeof volumesEnvSchema>[number];

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

export function rcloneMountArgs(volumeId: string, mountPath: string, hostApiUrl: string): string[] {
  return [
    'mount', ':webdav:', mountPath,
    '--webdav-url', `${hostApiUrl}/volumes/${volumeId}`,
    '--vfs-cache-mode', 'writes',
    '--vfs-write-back', '0s',
    '--dir-cache-time', '1s',
    // WebDAV keeps no file mode and rclone ignores chmod, so every file is executable, or no script could run.
    '--file-perms', '0777',
    // Shutdown asks this socket which uploads are still running. Any claude process can use it, including to quit
    // rclone, which claude can already do by killing it.
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

async function mountVolume({ volumeId, name }: ContainerMount): Promise<ChildProcess | undefined> {
  const mountPath = path.join(MOUNTS_DIR, name);
  let rclone: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  try {
    await fs.promises.mkdir(mountPath, { recursive: true });
    const unmountedDev = (await fs.promises.stat(mountPath)).dev;
    const child = spawn('rclone', rcloneMountArgs(volumeId, mountPath, process.env.SUPERAGENT_HOST_API_URL ?? ''), {
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

function uploadsRunning(volumeId: string): Promise<string[]> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: controlSocket(volumeId), path: '/core/stats', method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve((JSON.parse(body).transferring ?? []).map((t: { name: string }) => t.name)));
    });
    // No answer means rclone is gone, so nothing is uploading.
    req.on('error', () => resolve([]));
    req.end();
  });
}

// A closed file keeps uploading in the background, and rclone drops that upload when stopped.
// Returns what was still uploading once the deadline passes.
export async function waitForUploads(uploads: () => Promise<string[]>, deadline: number): Promise<string[]> {
  let pending: string[] = [];
  while (Date.now() < deadline) {
    // A just-closed file shows up as a transfer a few ms later, so an answer right away can miss it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    pending = await uploads();
    if (pending.length === 0) return [];
  }
  return pending;
}

export async function unmountVolumes(deadline: number): Promise<void> {
  await Promise.all(mounted.map(async ({ volumeId, name, rclone }) => {
    const pending = await waitForUploads(() => uploadsRunning(volumeId), deadline);
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
