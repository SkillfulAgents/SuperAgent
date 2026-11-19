import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'

/** The one part of Chromium's Local State read here: its DPAPI-wrapped key. Everything else in the file is Chromium's. */
const localStateSchema = z.object({
  os_crypt: z.object({ encrypted_key: z.string().min(1) }).passthrough(),
}).passthrough()

/**
 * Whether Chromium's safeStorage key is on disk. On Windows that key is wrapped
 * by DPAPI and kept in `<userData>/Local State`, which Chromium writes some
 * seconds after it makes the key: a process that dies first takes the key with
 * it, and the next start makes another that opens no wrap made with the first.
 */
export async function localStateHasOsKey(userDataDir: string): Promise<boolean> {
  try {
    const text = await fs.readFile(path.join(userDataDir, 'Local State'), 'utf-8')
    return localStateSchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}
