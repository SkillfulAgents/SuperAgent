/**
 * Atomic file writes for the agent container.
 *
 * Self-contained (the container can't import the host's @shared helpers) and
 * behaviour-compatible with the host's writeFileAtomic in
 * `src/shared/lib/utils/file-storage.ts`:
 *   write a sibling temp file in the same dir → fsync → rename → fsync dir.
 * A reader sees the whole old file or the whole new file, never a torn mix, and
 * an interrupted/killed write leaves the previous good file intact — closing the
 * SUP-310 data-loss bug-class for the container's own /workspace state files.
 *
 * `mode` (matching fs.writeFile) applies only when CREATING the target; an
 * existing file's permissions are preserved so the rename doesn't reset perms
 * the host relies on for cross-process access (e.g. the world-writable
 * /workspace/.env). The whole workspace dir is bind-mounted, so a temp file +
 * rename within it is on the same filesystem and propagates to the host.
 */
import * as fs from 'fs';
import * as path from 'path';

let tmpCounter = 0;

function randomSuffix(length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** Sibling temp path in the same directory (so the rename is atomic — same
 *  filesystem). pid + counter + random keeps it unique even after a pid reuse
 *  leaves a stray temp behind. */
function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.${process.pid}.${++tmpCounter}.${randomSuffix()}.tmp`);
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, 'r');
    await handle.sync();
  } catch {
    // best-effort durability (e.g. platforms that disallow dir fsync)
  } finally {
    await handle?.close().catch(() => {});
  }
}

function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // best-effort durability
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Atomically write `content` to `filePath` (temp file → fsync → rename → fsync
 * dir). On ANY error the temp file is removed and the existing target is left
 * exactly as it was. The parent directory must already exist.
 */
export async function writeFileAtomic(filePath: string, content: string, mode = 0o666): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = tempPathFor(filePath);
  let existingMode: number | undefined;
  try {
    existingMode = (await fs.promises.stat(filePath)).mode & 0o777;
  } catch {
    // target absent → create with `mode`
  }
  try {
    // 'wx' = O_EXCL: never reuse a stray temp file. Unique name makes this safe.
    const handle = await fs.promises.open(tmpPath, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf-8');
      if (existingMode !== undefined) await handle.chmod(existingMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  await fsyncDir(dir);
}

/** Synchronous twin of {@link writeFileAtomic}, for synchronous call sites. */
export function writeFileAtomicSync(filePath: string, content: string, mode = 0o666): void {
  const dir = path.dirname(filePath);
  const tmpPath = tempPathFor(filePath);
  let existingMode: number | undefined;
  try {
    existingMode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // target absent → create with `mode`
  }
  try {
    const fd = fs.openSync(tmpPath, 'wx', mode);
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      if (existingMode !== undefined) fs.fchmodSync(fd, existingMode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  fsyncDirSync(dir);
}
