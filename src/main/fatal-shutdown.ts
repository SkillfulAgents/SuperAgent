/** Longer than the host's 100s stop budget, including error-report flushing. */
export const FATAL_SHUTDOWN_TIMEOUT_MS = 120_000

type FatalShutdownDependencies = {
  flush: () => Promise<unknown>
  shutdown: () => Promise<boolean>
  exit: (code: number) => void
  logError: (message: string, error?: unknown) => void
}

/** Fatal errors cannot leave the app running indefinitely after a refused drain.
 * This deadline is separate from ordinary, cancellable user-requested quit. */
export function createFatalShutdown(deps: FatalShutdownDependencies): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    let exited = false
    const finish = () => {
      if (exited) return
      exited = true
      clearTimeout(deadline)
      deps.exit(1)
    }
    // Arm before any async work: even flushing reports or shutdown can hang.
    const deadline = setTimeout(() => {
      deps.logError('Fatal shutdown deadline reached; exiting. Some agent containers may still be running with unsynced files.')
      finish()
    }, FATAL_SHUTDOWN_TIMEOUT_MS)

    void (async () => {
      try {
        await deps.flush()
      } catch (error) {
        deps.logError('Could not flush fatal error reports; continuing shutdown:', error)
      }
      if (exited) return
      try {
        if (await deps.shutdown()) finish()
        else if (!exited) deps.logError('Safe shutdown was declined after a fatal error. The app will exit at the two-minute fatal deadline; pending uploads may not finish.')
      } catch (error) {
        if (!exited) deps.logError('Fatal shutdown failed. The app will exit at the two-minute fatal deadline:', error)
      }
    })()
  }
}
