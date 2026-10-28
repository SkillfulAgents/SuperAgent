import { servedRange } from '@shared/lib/utils/http-range'
import { guessMimeType } from '@shared/lib/utils/mime'
import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'
import { Hono } from 'hono'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { z } from 'zod'
import { Authenticated, getReadableAgentIds } from '../middleware/auth'
import { volumeViewer } from '../lib/volume-access'
import { afterVolumeChange } from '../lib/mount-change'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, reconnectLocalVolume, updateVolumeDefinition, VolumeError, openVolumeDefinition, listVolumeAttachments } from '@shared/lib/services/volume-service'

const routes = new Hono()
routes.use('*', Authenticated())
routes.onError((error, c) => {
  if (error instanceof VolumeError) {
    if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter))
    return c.json({ error: error.message }, error.status)
  }
  if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
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
  const file = await volume.read(path)
  try {
    const served = servedRange(c.req.header('range'), file.size)
    const inline = c.req.query('inline') === 'true'
    const name = path.split('/').at(-1)!
    const encoded = encodeURIComponent(name)
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encoded}"; filename*=UTF-8''${encoded}`)
    c.header('Content-Type', inline ? guessMimeType(name) : 'application/octet-stream')
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('X-Content-Type-Options', 'nosniff')
    // User files must never execute as the app's origin, including when opened in a new tab.
    c.header('Content-Security-Policy', 'sandbox allow-scripts')
    const range = served.range ?? (file.size > 0 ? { start: 0, end: file.size - 1 } : null)
    if (served.status === 416 || c.req.method === 'HEAD' || !range) {
      await file.close()
      return c.body(null, served.status, served.headers)
    }
    return c.body(await file.stream(range), served.status, served.headers)
  } catch (error) {
    await file.close()
    throw error
  }
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
