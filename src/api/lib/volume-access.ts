import type { Context } from 'hono'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import type { VolumeViewer } from '@shared/lib/services/volume-service'

export function volumeViewer(c: Context): VolumeViewer {
  const user = c.get('user' as never) as { role?: string } | undefined
  return { userId: isAuthMode() ? getCurrentUserId(c) : null, admin: !isAuthMode() || user?.role === 'admin' }
}
