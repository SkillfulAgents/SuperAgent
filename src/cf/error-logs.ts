/**
 * Workers Logs keep only the stack frames of an error passed to console, without its name and
 * message, so the log says where something failed but not why. Errors logged with console.error
 * and console.warn are written as text instead: name, message, stack, then each cause.
 */
export function logErrorsAsText(target: Pick<Console, 'error' | 'warn'> = console): void {
  for (const level of ['error', 'warn'] as const) {
    const write = target[level].bind(target)
    target[level] = (...args: unknown[]) => write(...args.map((arg) => (arg instanceof Error ? errorText(arg) : arg)))
  }
}

const MAX_CAUSES = 3

export function errorText(error: Error, causes = 0): string {
  const heading = `${error.name}: ${error.message}`
  const text = error.stack?.startsWith(heading) ? error.stack : `${heading}\n${error.stack ?? ''}`.trimEnd()
  return error.cause instanceof Error && causes < MAX_CAUSES ? `${text}\nCaused by: ${errorText(error.cause, causes + 1)}` : text
}
