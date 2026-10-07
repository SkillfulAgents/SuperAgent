import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated } from '../middleware/auth'
import { listVolumeFolders } from '@shared/lib/services/volume-folder-browser'
import { volumeViewer } from '../lib/volume-access'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, updateVolumeDefinition, VolumeError } from '@shared/lib/services/volume-service'

const routes = new Hono()
routes.use('*', Authenticated())
routes.onError((error, c) => {
  if (error instanceof VolumeError) return c.json({ error: error.message }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid volume configuration' }, 400)
  console.error('[volumes] Definition request failed:', error)
  return c.json({ error: 'Could not update volumes' }, 500)
})

// Browsing and creating local volumes share the authenticated workspace boundary.
routes.get('/folders', async c => c.json(await listVolumeFolders(c.req.query())))
routes.get('/', async c => c.json(await listVolumeDefinitions(volumeViewer(c))))
routes.post('/', async c => {
  const id = await createVolumeDefinition(await c.req.json(), volumeViewer(c))
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'volume', objectId: id, action: 'created' })
  return c.json({ id }, 201)
})
routes.patch('/:id', async c => {
  const id = c.req.param('id')
  await updateVolumeDefinition(id, await c.req.json(), volumeViewer(c))
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'volume', objectId: id, action: 'updated' })
  return c.json({ success: true })
})
routes.delete('/:id', async c => {
  const id = c.req.param('id')
  await deleteVolumeDefinition(id, volumeViewer(c))
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'volume', objectId: id, action: 'deleted' })
  return c.json({ success: true })
})

export default routes
