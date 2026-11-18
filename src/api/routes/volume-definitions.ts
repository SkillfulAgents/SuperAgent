import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'
import { Hono } from 'hono'
import { z } from 'zod'
import { Authenticated, getReadableAgentIds } from '../middleware/auth'
import { volumeViewer } from '../lib/volume-access'
import { serveVolumeFile, volumeErrorResponse } from '../lib/volume-file'
import { afterVolumeChange } from '../lib/mount-change'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, reconnectLocalVolume, updateVolumeDefinition, openVolumeDefinition, listVolumeAttachments } from '@shared/lib/services/volume-service'

const routes = new Hono()
routes.use('*', Authenticated())
routes.onError((error, c) => {
  const known = volumeErrorResponse(c, error)
  if (known) return known
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid drive configuration' }, 400)
  console.error('[volumes] Definition request failed:', error)
  if (c.req.path.endsWith('/folders') || c.req.path.endsWith('/file')) return c.json({ error: 'This drive is unavailable. Please try again.' }, 503)
  return c.json({ error: 'Could not update drives' }, 500)
})

// These routes authorize the definition before reaching the source. A private definition
// remains private even if the caller can see an agent that has it attached.
routes.get('/:id/agents', async c => {
  const attachments = await listVolumeAttachments(c.req.param('id'), volumeViewer(c))
  const readable = await getReadableAgentIds(c, attachments.map(item => item.agentSlug))
  return c.json({ attachments: attachments.filter(item => readable.has(item.agentSlug)) })
})

routes.get('/:id/folders', async c => {
  const { path } = volumeBrowseSchema.parse(c.req.query())
  const volume = await openVolumeDefinition(c.req.param('id'), volumeViewer(c))
  const entries = (await volume.list(path))
    .filter(entry => entry.kind === 'file' || entry.kind === 'directory')
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
    .map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.kind, mtimeMs: entry.mtimeMs }))
  return c.json({ root: '', path, entries, truncated: false })
})

routes.get('/:id/file', async c => {
  const { path } = volumeBrowseSchema.parse(c.req.query())
  if (!path) return c.json({ error: 'File path is required' }, 400)
  const volume = await openVolumeDefinition(c.req.param('id'), volumeViewer(c))
  return serveVolumeFile(c, volume, path)
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
routes.post('/:id/reconnect', async c => {
  const id = c.req.param('id')
  await reconnectLocalVolume(id, await c.req.json(), volumeViewer(c))
  // An agent that started while the folder couldn't be opened has no mount for it until it restarts.
  await afterVolumeChange(id)
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
