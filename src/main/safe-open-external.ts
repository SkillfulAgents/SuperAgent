import { shell } from 'electron'
import { z } from 'zod'

// Schemes we are willing to hand to the OS shell via shell.openExternal.
//
// Everything outside this set (file:, javascript:, data:, vbscript:, ftp:,
// and arbitrary custom app protocols like myapp://) is dropped: in Electron,
// shell.openExternal asks the OS to launch a registered handler, which can
// start local apps or privileged flows entirely outside the browser sandbox.
// Only http/https (normal web links, OAuth, localhost redirects) and mailto:
// are considered safe enough to forward.
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

// Validate at the boundary (CLAUDE.md): the input must be a non-empty string
// that parses into a URL whose protocol is on the allowlist. `new URL()` throws
// on malformed input, which the refine catches and turns into a parse failure.
const SafeExternalUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return ALLOWED_PROTOCOLS.has(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'URL scheme is not on the safe-open allowlist')

/**
 * Type guard: true only when `url` is a string with an allowlisted web scheme.
 * Never throws — non-string / empty / malformed input returns false.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  return SafeExternalUrlSchema.safeParse(url).success
}

/**
 * Scheme-checked wrapper around shell.openExternal. Forwards only URLs whose
 * scheme is on the allowlist; logs and drops anything else (including
 * non-string / malformed input) without throwing.
 *
 * @returns true if the URL was forwarded to the shell, false if it was dropped.
 */
export async function safeOpenExternal(url: unknown): Promise<boolean> {
  const result = SafeExternalUrlSchema.safeParse(url)
  if (!result.success) {
    const printable = typeof url === 'string' ? url : `<${typeof url}>`
    console.warn(`safe-open-external: refusing to open disallowed URL: ${printable}`)
    return false
  }
  await shell.openExternal(result.data)
  return true
}
