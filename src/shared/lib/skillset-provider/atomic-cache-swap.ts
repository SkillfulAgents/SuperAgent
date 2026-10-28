import fs from 'fs'

/**
 * Atomic, non-destructive cache swap.
 *
 * The naive refresh (rm(cacheDir) then rename(tmpDir, cacheDir)) destroys the
 * working cache *before* the new one is in place. On Windows the rename can fail
 * with EPERM/EBUSY when antivirus or another handle briefly locks the directory,
 * leaving the user with NO cache at all rather than a merely-failed refresh
 * (Sentry ELECTRON-4G).
 *
 * This helper preserves the old cache until the new dir is fully in place:
 *   1. move the existing cache aside to a backup path,
 *   2. move the freshly-populated tmp dir into place (with bounded retries, then
 *      a copy fallback for stubborn Windows locks),
 *   3. delete the backup on success.
 * On ANY failure the backup is restored so the user keeps a working cache.
 */
export async function atomicSwapCacheDir(cacheDir: string, tmpDir: string): Promise<void> {
  const backupDir = cacheDir + '.bak-' + Date.now()
  let movedAside = false

  try {
    // Step aside the old cache only if it exists. force:true makes rm a no-op
    // when missing, but we must know whether a restore is needed on failure.
    if (await pathExists(cacheDir)) {
      await moveDir(cacheDir, backupDir)
      movedAside = true
    }

    // Promote the new cache into place. If this throws after the old cache was
    // moved aside, the catch restores the backup so the user is never left
    // cacheless.
    await moveDir(tmpDir, cacheDir)
  } catch (err) {
    // Restore the previous cache if we had moved it aside but failed to install
    // the new one. Best-effort: a restore failure must not mask the original.
    if (movedAside && !(await pathExists(cacheDir))) {
      await moveDir(backupDir, cacheDir).catch(() => {})
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  // New cache is committed — drop the backup. A leftover backup is harmless, so
  // swallow errors here rather than failing an otherwise-successful refresh.
  await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {})
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Move a directory with a bounded retry around transient Windows locks
 * (EPERM/EBUSY/EACCES from AV or open handles), falling back to a recursive
 * copy + delete if rename keeps failing.
 */
async function moveDir(src: string, dest: string): Promise<void> {
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(src, dest)
      return
    } catch (err) {
      if (attempt === MAX_ATTEMPTS - 1 || !isTransientLockError(err)) {
        // Last resort: copy-into-place. rename can also fail with EXDEV when
        // src and dest straddle filesystems, which a copy handles too.
        if (isTransientLockError(err) || isCrossDeviceError(err)) {
          await fs.promises.cp(src, dest, { recursive: true, force: true })
          await fs.promises.rm(src, { recursive: true, force: true }).catch(() => {})
          return
        }
        throw err
      }
      await delay(100 * (attempt + 1))
    }
  }
}

function isTransientLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function isCrossDeviceError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EXDEV'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
