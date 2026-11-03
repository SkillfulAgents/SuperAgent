import { v4 as uuidv4 } from 'uuid'
import { hostState } from '../host-state/backend'
import { defineSingletonHostFile } from '../host-state/singletons'

const TENANT_ID_FILE = 'tenant-id'

defineSingletonHostFile(TENANT_ID_FILE, () => uuidv4())

/**
 * Get the persistent tenant ID for this installation.
 * Generated once on first access and stored with the host files.
 */
export function getTenantId(): string {
  let id = ''
  try {
    id = hostState().singleton(TENANT_ID_FILE).trim()
  } catch {
    // An unreadable file gets a new id below.
  }
  if (id) return id
  // An empty file (a write cut short) or an unreadable one: replace it with a new id.
  return hostState().write(TENANT_ID_FILE, () => uuidv4()).trim()
}
