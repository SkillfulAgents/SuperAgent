import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Clear what a killed launch left of Chromium's process-singleton files, so
 * this launch can take the single-instance lock. Returns whether it cleared any.
 *
 * Only needed in the App Sandbox build. There Electron keeps the singleton
 * socket and cookie in a fixed, short directory (`<temp>/S`) instead of a fresh
 * one per launch, so after a SIGKILL or a crash they are still there, and the
 * next launch fails to create its own ("SingletonCookie: File exists"), is
 * refused the lock and quits without a window. Chromium cleans up during that
 * failed launch, so the one after works: without this, every relaunch after a
 * crash takes two attempts.
 *
 * Cleared only when the lock names this computer and a process that no longer
 * exists. A live launch, ours or another's, is left alone: in the sandbox,
 * signalling one that isn't ours fails with EPERM, which counts as alive.
 */
export function clearStaleProcessSingleton(userDataDir: string): boolean {
  const lock = path.join(userDataDir, 'SingletonLock')
  let owner: string
  try {
    owner = fs.readlinkSync(lock)
  } catch {
    return false
  }
  // `<hostname>-<pid>`; hostnames may contain '-'.
  const split = owner.lastIndexOf('-')
  const pid = Number(owner.slice(split + 1))
  if (split < 1 || owner.slice(0, split) !== os.hostname() || !Number.isInteger(pid) || pid <= 0 || isAlive(pid)) {
    return false
  }

  const socketLink = path.join(userDataDir, 'SingletonSocket')
  let socketDir: string | null = null
  try {
    socketDir = path.dirname(fs.readlinkSync(socketLink))
  } catch {
    // No socket link: only the files next to the lock are left.
  }
  const stale = [lock, socketLink, path.join(userDataDir, 'SingletonCookie')]
  if (socketDir) stale.push(path.join(socketDir, 'SingletonSocket'), path.join(socketDir, 'SingletonCookie'))
  for (const file of stale) {
    try {
      fs.unlinkSync(file)
    } catch {
      // Already gone.
    }
  }
  return true
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
