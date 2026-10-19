import type { Context } from 'hono'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import type { VolumeViewer } from '@shared/lib/services/volume-service'
import { agentRegistry } from '@shared/lib/agent-actor'

export function volumeViewer(c: Context): VolumeViewer {
  const user = c.get('user' as never) as { role?: string } | undefined
  return { userId: isAuthMode() ? getCurrentUserId(c) : null, admin: !isAuthMode() || user?.role === 'admin' }
}

// A running container keeps the drives it started with until it restarts.
export async function afterMountChange(agentSlug: string, restart?: boolean) {
  const container = agentRegistry.get(agentSlug).container
  if (container.status().status !== 'running') return
  if (restart) await container.restart()
  else container.markStale()
}
