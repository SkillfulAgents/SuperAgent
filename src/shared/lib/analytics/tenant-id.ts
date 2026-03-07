import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDataDir } from '../config/data-dir'

const TENANT_ID_FILE = 'tenant-id'

let cachedTenantId: string | null = null

/**
 * Get the persistent tenant ID for this installation.
 * Generated once on first access and stored in the data directory.
 */
export function getTenantId(): string {
  if (cachedTenantId) return cachedTenantId

  const filePath = path.join(getDataDir(), TENANT_ID_FILE)

  try {
    if (fs.existsSync(filePath)) {
      const id = fs.readFileSync(filePath, 'utf-8').trim()
      if (id) {
        cachedTenantId = id
        return id
      }
    }
  } catch {
    // Fall through to generate new ID
  }

  // Generate and persist a new tenant ID
  const newId = uuidv4()
  const dataDir = getDataDir()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  fs.writeFileSync(filePath, newId, 'utf-8')
  cachedTenantId = newId
  return newId
}
