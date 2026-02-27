/**
 * Check if auth mode is enabled.
 * Auth mode is web-only — ignored in Electron.
 *
 * This is in a separate file (not auth/index.ts) to avoid pulling in
 * better-auth ESM dependencies in Electron's CommonJS main process.
 */
export function isAuthMode(): boolean {
  // Electron guard: process.type === 'browser' means Electron main process
  if (process.type === 'browser') {
    if (process.env.AUTH_MODE === 'true') {
      console.warn('AUTH_MODE is not supported in Electron. Ignoring.')
    }
    return false
  }
  return process.env.AUTH_MODE === 'true'
}
