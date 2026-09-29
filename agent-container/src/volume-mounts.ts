import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
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

let mountedPaths: string[] = [];

export function parseVolumes(raw: string | undefined): ContainerMount[] {
  if (!raw) return [];
  try {
    return volumesEnvSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.error('[volumes] Ignoring invalid SUPERAGENT_VOLUMES:', error);
    return [];
  }
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

async function mountVolume({ volumeId, name }: ContainerMount): Promise<string | null> {
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
    return mountPath;
  } catch (error) {
    console.error(`[volumes] Leaving out ${mountPath}:`, error);
    rclone?.kill();
    await execFileAsync('fusermount3', ['-uz', mountPath]).catch(() => {});
    return null;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

export async function mountVolumes(mounts: ContainerMount[]): Promise<void> {
  const paths = await Promise.all(mounts.map(mountVolume));
  mountedPaths = paths.filter((p) => p !== null);
}

export function mountedVolumePaths(): string[] {
  return mountedPaths;
}
