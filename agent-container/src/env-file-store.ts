/**
 * Cross-process-safe writes for /workspace/.env.
 *
 * The agent `.env` is written by BOTH the host app (secrets-service) AND this
 * container (POST /env, reserved runtime vars), against the same bind-mounted
 * file. Without coordination an interleaved read-modify-write drops the
 * other writer's keys, and a non-atomic write can truncate the file mid-stream —
 * which breaks the running session (the file doubles as the runtime env).
 *
 * This module is intentionally self-contained (the container can't import the
 * host's @shared helpers) and MUST stay protocol-compatible with the host's
 * `withCrossProcessFileLock` in `src/shared/lib/utils/file-storage.ts`:
 *   - same lockfile path: `<target>.lock`, created with O_EXCL,
 *   - a lock older than `STALE_MS` is treated as stale and stolen.
 *
 * The atomic write itself lives in `./atomic-file` (shared with the container's
 * other /workspace state writers); it is re-exported here so existing callers
 * (server.ts) keep importing it from this module.
 */
import * as fs from 'fs';

export { writeFileAtomic } from './atomic-file';

const TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding `<targetPath>.lock` (O_EXCL), mutually exclusive with
 * the host app's writer. Steals a stale lock left by a crashed writer; always
 * releases in a finally.
 */
export async function withEnvFileLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  // Unique owner token so release only removes a lock we still hold.
  const ownerToken = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      try {
        await handle.writeFile(ownerToken);
      } finally {
        await handle.close();
      }
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${TIMEOUT_MS}ms acquiring lock ${lockPath}`);
      }
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    // Release only if we still own it — if the host app stole our stale lock,
    // the file holds its token now and we must not delete it (would reopen the
    // cross-process lost-update race the lock exists to prevent).
    const current = await fs.promises.readFile(lockPath, 'utf-8').catch(() => null);
    if (current === ownerToken) {
      await fs.promises.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}
