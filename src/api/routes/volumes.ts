import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Authenticated } from '../middleware/auth'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getSettings } from '@shared/lib/config/settings'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import {
  SharedVolumeError,
  createSharedVolume,
  deleteSharedVolume,
  listSharedVolumes,
} from '@shared/lib/services/shared-volume-service'

const volumes = new Hono()

const CLOUD_RUNNERS = ['kubernetes', 'lambda-microvm']

function cloudVolumesSupported(): boolean {
  return CLOUD_RUNNERS.includes(getSettings().container.containerRunner)
}

function callerFrom(c: Context): { userId: string | null; isAdmin: boolean } {
  const user = c.get('user' as never) as { role?: string } | undefined
  return {
    userId: getCurrentUserId(c),
    isAdmin: user?.role === 'admin',
  }
}

function handleError(c: Context, error: unknown, fallback: string) {
  if (error instanceof SharedVolumeError) {
    return c.json({ error: error.message }, error.status)
  }
  console.error(fallback, error)
  return c.json({ error: fallback }, 500)
}

volumes.get('/', Authenticated(), (c) => {
  return c.json({
    supported: cloudVolumesSupported(),
    volumes: listSharedVolumes(),
  })
})

volumes.post(
  '/',
  Authenticated(),
  zValidator('json', z.object({ name: z.string().min(1) })),
  async (c) => {
    try {
      const { name } = c.req.valid('json')
      const volume = await createSharedVolume(name)
      logAuditEvent({
        userId: getCurrentUserId(c),
        object: 'volume',
        objectId: volume.id,
        action: 'created',
        details: { name: volume.name, mountName: volume.mountName },
      })
      return c.json(volume, 201)
    } catch (error) {
      return handleError(c, error, 'Failed to create shared volume')
    }
  },
)

volumes.delete('/:id', Authenticated(), async (c) => {
  try {
    const id = c.req.param('id')
    await deleteSharedVolume(id, callerFrom(c))
    logAuditEvent({
      userId: getCurrentUserId(c),
      object: 'volume',
      objectId: id,
      action: 'deleted',
    })
    return c.json({ success: true })
  } catch (error) {
    return handleError(c, error, 'Failed to delete shared volume')
  }
})

export default volumes
