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
import { writeFileAtomic } from './atomic-file';

export { writeFileAtomic };

const TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding `<targetPath>.lock` (O_EXCL), mutually exclusive with
 * the host app's writer. Steals a stale lock left by a crashed writer; always
 * releases in a finally.
 *
 * Shares the host's accepted stale-steal limitation (no heartbeat → an
 * alive-but-frozen >STALE_MS holder can be falsely stolen; worst case is one lost
 * env-var update, never corruption). See `withCrossProcessFileLock` in the host's
 * file-storage.ts for the full rationale.
 */
export async function withEnvFileLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  // Unique owner token so release only removes a lock we still hold.
  const ownerToken = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + TIMEOUT_MS;
  let acquiredAt = 0;

  for (;;) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      try {
        await handle.writeFile(ownerToken);
      } finally {
        await handle.close();
      }
      acquiredAt = Date.now();
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
    // cross-process lost-update race the lock exists to prevent). If the readback
    // fails transiently (→ null) we can't see the token, but a steal only happens
    // after STALE_MS, so while we've held it for less than that it's provably ours
    // — remove it rather than leak our own lock.
    const current = await fs.promises.readFile(lockPath, 'utf-8').catch(() => null);
    if (current === ownerToken || (current === null && Date.now() - acquiredAt < STALE_MS)) {
      await fs.promises.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

// Read-retry budget. On the shared S3 File Gateway NFS, the host app's atomic
// rename-replace of .env swaps the inode; this client's cached lookup can then
// fail with ESTALE (or transiently ENOENT) for up to the attribute-cache window
// (~3s) even though the file exists. Retry across that window before concluding
// anything.
const READ_RETRY_BASE_MS = 150;
const READ_ATTEMPTS_ENOENT = 3; // genuinely-absent is common (first secret) — give up fast
const READ_ATTEMPTS_OTHER = 6; // ESTALE/EIO: ~2.3s total, spans the NFS attr-cache window

/**
 * Read the env file, retrying transient errors. Returns null ONLY for a
 * persistent ENOENT (file genuinely absent). Any other persistent error THROWS.
 *
 * Fail-closed is load-bearing: treating an unreadable .env as empty and then
 * writing the merge result back atomically wiped every secret in the file
 * (observed in prod when a host-side rename raced this client's NFS cache).
 */
export async function readEnvFileOrNull(filePath: string): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const maxAttempts = code === 'ENOENT' ? READ_ATTEMPTS_ENOENT : READ_ATTEMPTS_OTHER;
      if (attempt >= maxAttempts) {
        if (code === 'ENOENT') return null;
        throw err;
      }
      await sleep(READ_RETRY_BASE_MS * attempt);
    }
  }
}

/** Quote a value for the env file: always double-quoted, with backslashes,
 *  embedded quotes and newlines escaped so one value can never break the file's
 *  line structure. Mirrors the host's serializeEnvFile escaping (the inverse of
 *  its parseEnvFile unescape) so values round-trip across both writers. */
function encodeEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * Upsert `key=value` into env-file `content`, preserving every other line
 * byte-for-byte — the host app owns this file's header and writes display-name
 * comments (`KEY=v  # Name`) that a parse-and-reserialize would destroy.
 * Replaces the first line defining `key` (keeping its inline comment), drops any
 * duplicate definitions, appends at the end when the key is new.
 */
export function upsertEnvContent(content: string, key: string, value: string): string {
  const encoded = encodeEnvValue(value);
  const lines = content.split('\n');
  const out: string[] = [];
  let replaced = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0 && line.slice(0, eqIndex).trim() === key) {
        if (replaced) continue; // drop duplicate definitions of the same key
        replaced = true;
        const rest = line.slice(eqIndex + 1);
        // Keep a trailing comment (host display name). Quote-aware: a '#'
        // inside a quoted value is part of the value, not a comment.
        const m = rest.match(/^(".*?"|'.*?'|[^#]*?)(\s+#\s*.*)$/);
        out.push(line.slice(0, eqIndex + 1) + encoded + (m ? m[2] : ''));
        continue;
      }
    }
    out.push(line);
  }

  if (!replaced) {
    // Append after the last non-empty line so the file keeps a single trailing
    // newline instead of accumulating blank lines across upserts.
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(`${key}=${encoded}`);
  }
  return out.join('\n') + (out[out.length - 1] === '' ? '' : '\n');
}

/**
 * Cross-process-safe upsert of a single `key=value` into the env file:
 * lock → fail-closed read → line-preserving merge → atomic write.
 *
 * Created with mode 0o666 (matching the host's setSecret) so whichever side
 * creates the file first, the other side — a different uid — can still write it.
 */
export async function updateEnvFileEntry(filePath: string, key: string, value: string): Promise<void> {
  await withEnvFileLock(filePath, async () => {
    const existing = await readEnvFileOrNull(filePath);
    const next = upsertEnvContent(existing ?? '', key, value);
    await writeFileAtomic(filePath, next, 0o666);
  });
}
