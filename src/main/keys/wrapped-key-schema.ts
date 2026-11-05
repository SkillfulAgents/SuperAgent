import { z } from 'zod'

/**
 * A purpose's key as the desktop keeps it: wrapped by Electron safeStorage
 * (whose own key lives in the macOS Keychain, Windows DPAPI, or the Linux
 * keyring), in a file in the data directory. The file alone opens nothing.
 */
export const wrappedKeyFileSchema = z.object({
  version: z.literal(1),
  purpose: z.string().min(1),
  protection: z.literal('electron-safe-storage'),
  /** The safeStorage backend it was wrapped with ('keychain', 'dpapi', 'gnome_libsecret', …): named when it cannot be unwrapped. */
  backend: z.string().min(1),
  /** safeStorage's ciphertext of the key's base64, base64. */
  wrapped: z.string().min(1),
  /** keyCheckValue() of the key: tells a wrong unwrap from the right one. */
  check: z.string().min(1),
  createdAt: z.string(),
}).strict()

export type WrappedKeyFile = z.infer<typeof wrappedKeyFileSchema>
