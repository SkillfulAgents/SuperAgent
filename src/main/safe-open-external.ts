import { shell } from 'electron'
import { z } from 'zod'

// Schemes safe to hand to the OS shell from ANY context, INCLUDING popups opened
// by untrusted web / dashboard / agent-rendered content (setWindowOpenHandler):
//   - http/https: normal web links, OAuth, localhost redirects.
//   - mailto/sms/tel: "communication composer" handlers. Each opens a prefilled
//     compose/dial UI, but the USER must still confirm before anything is sent or
//     dialed — no code execution, no file access. (sms:/tel: can prefill a
//     premium-rate number/shortcode, a minor user-gated social-engineering angle,
//     but are otherwise the same class as the long-allowed mailto:.)
// Everything outside this set (file:, javascript:, data:, vbscript:, ftp:, and
// arbitrary custom app protocols like myapp://) is dropped: shell.openExternal
// asks the OS to launch a registered handler, which can start local apps or
// privileged flows entirely outside the browser sandbox.
const POPUP_PROTOCOLS = ['https:', 'http:', 'mailto:', 'sms:', 'tel:'] as const

// Schemes allowed ONLY from first-party app UI (the open-external IPC), never from
// untrusted popups. Opening a macOS System Settings pane has no legitimate use from
// agent/web content, so the computer-use permission helper can reach it while
// dashboard/agent content cannot.
const APP_ONLY_PROTOCOLS = ['x-apple.systempreferences:'] as const

// Validate at the boundary (CLAUDE.md): the input must be a non-empty string that
// parses into a URL whose protocol is on the allowlist. `new URL()` throws on
// malformed input, which the refine catches and turns into a parse failure.
function makeAllowlistSchema(protocols: readonly string[]) {
  const allowed = new Set<string>(protocols)
  return z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return allowed.has(new URL(value).protocol)
      } catch {
        return false
      }
    }, 'URL scheme is not on the safe-open allowlist')
}

const PopupUrlSchema = makeAllowlistSchema(POPUP_PROTOCOLS)
const AppUrlSchema = makeAllowlistSchema([...POPUP_PROTOCOLS, ...APP_ONLY_PROTOCOLS])

async function forward(
  schema: ReturnType<typeof makeAllowlistSchema>,
  url: unknown,
  context: string,
): Promise<boolean> {
  const result = schema.safeParse(url)
  if (!result.success) {
    const printable = typeof url === 'string' ? url : `<${typeof url}>`
    console.warn(`safe-open-external (${context}): refusing to open disallowed URL: ${printable}`)
    return false
  }
  await shell.openExternal(result.data)
  return true
}

/**
 * Type guard: true only when `url` is a string with a scheme on the popup
 * allowlist (http/https/mailto/sms/tel — i.e. safe even from untrusted content).
 * Never throws.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  return PopupUrlSchema.safeParse(url).success
}

/**
 * Scheme-checked wrapper for UNTRUSTED callers (the popup setWindowOpenHandler,
 * which fires for web / dashboard / agent content). Forwards web links plus the
 * user-confirmed communication composers (mailto/sms/tel); logs and drops
 * everything else (file:/javascript:/custom, non-string / malformed input)
 * without throwing.
 *
 * @returns true if the URL was forwarded to the shell, false if it was dropped.
 */
export async function safeOpenExternal(url: unknown): Promise<boolean> {
  return forward(PopupUrlSchema, url, 'popup')
}

/**
 * Scheme-checked wrapper for FIRST-PARTY app UI (the `open-external` IPC handler).
 * Allows everything safeOpenExternal does, plus app-only OS deep-links
 * (x-apple.systempreferences: for the computer-use permission helper). Still drops
 * file:/javascript:/data:/custom protocols. Never throws.
 *
 * @returns true if the URL was forwarded to the shell, false if it was dropped.
 */
export async function safeOpenExternalFromApp(url: unknown): Promise<boolean> {
  return forward(AppUrlSchema, url, 'app')
}
