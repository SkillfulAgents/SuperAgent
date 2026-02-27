import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'

const AUTH_SECRET_FILENAME = '.auth-secret'

/**
 * Get or create the Better Auth secret.
 *
 * Priority:
 * 1. BETTER_AUTH_SECRET env var (explicit override)
 * 2. Persisted secret file (~/.superagent/.auth-secret)
 * 3. Generate new secret, persist to file, return
 */
export function getOrCreateAuthSecret(): string {
  // 1. Check env var
  const envSecret = process.env.BETTER_AUTH_SECRET
  if (envSecret) {
    return envSecret
  }

  const secretPath = path.join(getDataDir(), AUTH_SECRET_FILENAME)

  // 2. Check persisted file
  if (fs.existsSync(secretPath)) {
    const secret = fs.readFileSync(secretPath, 'utf-8').trim()
    if (secret.length >= 32) {
      return secret
    }
  }

  // 3. Generate new secret
  const secret = crypto.randomBytes(32).toString('base64')

  // Ensure data directory exists
  const dataDir = getDataDir()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Write with restrictive permissions (owner read/write only)
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })

  return secret
}
