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
  return hostState().singleton(TENANT_ID_FILE).trim()
}
