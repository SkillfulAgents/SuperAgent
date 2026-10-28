/**
 * Atomic file writes for the agent container.
 *
 * Self-contained (the container can't import the host's @shared helpers) and
 * behaviour-compatible with the host's writeFileAtomic in
 * `src/shared/lib/utils/file-storage.ts`:
 *   write a sibling temp file in the same dir → fsync → rename → fsync dir.
 * A reader sees the whole old file or the whole new file, never a torn mix, and
 * an interrupted/killed write leaves the previous good file intact — closing the
 * data-loss bug-class for the container's own /workspace state files.
 *
 * `mode` (matching fs.writeFile) applies only when CREATING the target; an
 * existing file's owner, group, and permissions are restored after the rename
 * (ownership best-effort — only root can give a file away), so replacing a
 * file doesn't silently re-own it to this process with fresh perms. The whole
 * workspace dir is bind-mounted, so a temp file + rename within it is on the
 * same filesystem and propagates to the host.
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
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode = 0o666,
  opts: { forceMode?: boolean } = {}
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = tempPathFor(filePath);
  // The rename below replaces the inode, handing the file to this process's
  // uid with the temp file's perms — so an existing target's owner, group, and
  // mode are restored (ownership best-effort: only root can give a file away).
  //
  // `forceMode` skips preservation for files that must hold `mode` no matter
  // what: the agent .env is a two-uid file and the non-root writer can never
  // chown it back, so a preserved stray restrictive mode would lock the other
  // writer out permanently — only a forced world-RW mode is uid-independent.
  let existing: { mode: number; uid: number; gid: number } | undefined;
  if (!opts.forceMode) {
    try {
      const st = await fs.promises.stat(filePath);
      existing = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
    } catch (err) {
      // Only a confirmed-absent target is a create. Anything else (ESTALE from a
      // cross-client NFS rename, EIO) must fail the write — treating it as a
      // create would silently reset the file's permissions to `mode`.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
  try {
    // 'wx' = O_EXCL: never reuse a stray temp file. Unique name makes this safe.
    const handle = await fs.promises.open(tmpPath, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf-8');
      // Best-effort: a perms-less mount (e.g. an S3 FUSE driver) may reject
      // chown/chmod — never let a metadata tweak fail the data write.
      // chown before chmod: chown can clear mode bits on some platforms.
      if (opts.forceMode) {
        await handle.chmod(mode).catch(() => {});
      } else if (existing) {
        await handle.chown(existing.uid, existing.gid).catch(() => {});
        await handle.chmod(existing.mode).catch(() => {});
      }
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
  let existing: { mode: number; uid: number; gid: number } | undefined;
  try {
    const st = fs.statSync(filePath);
    existing = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
  } catch (err) {
    // See writeFileAtomic: ENOENT-only, everything else fails the write.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  try {
    const fd = fs.openSync(tmpPath, 'wx', mode);
    try {
      fs.writeFileSync(fd, content, 'utf-8');
      // Best-effort (see writeFileAtomic): a perms-less mount's chown/chmod
      // rejection must not fail the data write. chown before chmod.
      if (existing) {
        try {
          fs.fchownSync(fd, existing.uid, existing.gid);
        } catch {
          // ignore — only root can give a file away
        }
        try {
          fs.fchmodSync(fd, existing.mode);
        } catch {
          // ignore — perms are advisory on object-storage mounts
        }
      }
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
