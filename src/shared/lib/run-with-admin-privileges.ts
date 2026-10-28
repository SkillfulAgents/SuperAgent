import { execFile } from 'child_process'

/**
 * Run a shell command with macOS administrator privileges via osascript.
 * Node-only — must not import electron (shared by main + API / startRunner).
 */
export function runWithAdminPrivileges(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`],
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
  })
}

/** True when the user dismissed the macOS password dialog. */
export function isAdminPrivilegeCancelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return (
    message.includes('User canceled') ||
    message.includes('User cancelled') ||
    message.includes('-128')
  )
}
