import { Hono } from 'hono'
import { DropboxMountableVolume } from '@shared/lib/volumes/dropbox-mountable-volume'
import { requireDropboxAccount } from '@shared/lib/volumes/dropbox-client'
import { DropboxUnavailableError } from '@shared/lib/volumes/dropbox-error'
import { dropboxBrowseSchema, dropboxFoldersSchema } from '@shared/lib/volumes/dropbox-schema'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { z } from 'zod'
import { Authenticated } from '../middleware/auth'
import { volumeViewer } from '../lib/volume-access'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, updateVolumeDefinition, VolumeError } from '@shared/lib/services/volume-service'

const routes = new Hono()
routes.use('*', Authenticated())
routes.onError((error, c) => {
  if (error instanceof DropboxUnavailableError) {
    if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter))
    return c.json({ error: error.message }, error.status)
  }
  if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
  if (error instanceof VolumeError) return c.json({ error: error.message }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid volume configuration' }, 400)
  console.error('[volumes] Definition request failed:', error)
  if (c.req.path.endsWith('/dropbox/folders')) return c.json({ error: new DropboxUnavailableError().message }, 503)
  return c.json({ error: 'Could not update volumes' }, 500)
})

routes.get('/dropbox/folders', async c => {
  const config = dropboxBrowseSchema.parse(c.req.query())
  await requireDropboxAccount(config.accountId, volumeViewer(c))
  const entries = await new DropboxMountableVolume('', '', config).list('')
  const result = dropboxFoldersSchema.safeParse({
    folders: entries.filter(entry => entry.kind === 'directory').map(entry => ({
      name: entry.name, path: `${config.path}/${entry.name}`,
    })),
  })
  if (!result.success) throw new DropboxUnavailableError()
  return c.json(result.data)
})

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
