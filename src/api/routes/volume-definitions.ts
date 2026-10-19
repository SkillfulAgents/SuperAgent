import { servedRange } from '@shared/lib/utils/http-range'
import { guessMimeType } from '@shared/lib/utils/mime'
import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'
import { Hono } from 'hono'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { z } from 'zod'
import { Authenticated, getReadableAgentIds } from '../middleware/auth'
import { afterMountChange, volumeViewer } from '../lib/volume-access'
import { serializeByKey } from '@shared/lib/utils/keyed-queue'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, updateVolumeDefinition, VolumeError, openVolumeDefinition, getVisibleVolumeDefinition, listVolumeAttachments } from '@shared/lib/services/volume-service'
import { listMyAgentSlugs, previewMyAgents, setMyAgentDrive } from '@shared/lib/services/mount-service'
import { myAgentDriveSchema, updateUserSettings } from '@shared/lib/services/user-settings-service'

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
    .map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, type: entry.kind }))
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

routes.get('/:id/my-agents', async c => {
  const { shared } = z.object({ shared: z.enum(['true', 'false']) }).parse(c.req.query())
  const viewer = volumeViewer(c)
  await getVisibleVolumeDefinition(c.req.param('id'), viewer)
  return c.json(await previewMyAgents(viewer.userId, shared === 'true'))
})
// "Add to all my agents": saved for agents created later, and applied now to each of the
// user's agents (private only, or with `shared` every agent they own), replacing access set on them by hand.
routes.put('/:id/my-agents', async c => {
  const id = c.req.param('id')
  const viewer = volumeViewer(c)
  const userId = getCurrentUserId(c)
  const setting = myAgentDriveSchema.strict().parse(await c.req.json())
  // The same checks attach makes, before anything is saved: the drive is visible and usable.
  await openVolumeDefinition(id, viewer)
  // One run per user at a time, so quick changes (and turning off) land in the order they were made.
  const agents = await serializeByKey(`my-agents:${userId}`, async () => {
    await updateUserSettings(userId, { myAgentDrives: { [id]: setting } })
    const slugs = await listMyAgentSlugs(viewer.userId, setting.shared)
    for (const slug of slugs) {
      if (await setMyAgentDrive(slug, id, setting.level, viewer)) await afterMountChange(slug)
    }
    return slugs.length
  })
  await logAuditEvent({ userId, object: 'volume', objectId: id, action: 'updated', details: { myAgents: setting, agents } })
  return c.json({ agents })
})
// Turning it off only stops new agents getting the drive; agents that have it keep it.
routes.delete('/:id/my-agents', async c => {
  const id = c.req.param('id')
  const userId = getCurrentUserId(c)
  await serializeByKey(`my-agents:${userId}`, () => updateUserSettings(userId, { myAgentDrives: { [id]: null } }))
  await logAuditEvent({ userId, object: 'volume', objectId: id, action: 'updated', details: { myAgents: 'off' } })
  return c.json({ success: true })
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
