import { v4 as uuidv4 } from 'uuid'
import { hostFiles } from '../host-state/host-files'
import { defineHostFileCreator } from '../host-state/host-file-creators'

const TENANT_ID_FILE = 'tenant-id'

defineHostFileCreator(TENANT_ID_FILE, () => uuidv4())

/**
 * Get the persistent tenant ID for this installation.
 * Generated once on first access and stored with the host files.
 */
export function getTenantId(): string {
  let id = ''
  try {
    id = hostFiles().getOrCreate(TENANT_ID_FILE).trim()
  } catch {
    // An unreadable file gets a new id below.
  }
  if (id) return id
  // An empty file (a write cut short) or an unreadable one: replace it with a new id.
  return hostFiles().write(TENANT_ID_FILE, () => uuidv4()).trim()
}
