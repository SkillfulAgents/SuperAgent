import { volumeValidationSchema } from '@shared/lib/volumes/volume-validation-schema'
import { Hono } from 'hono'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { browseVolumeFolders, validateVolumeSource } from '@shared/lib/volumes/volume-factory'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { Authenticated } from '../middleware/auth'
import { volumeViewer } from '../lib/volume-access'

const routes = new Hono()
routes.use('*', Authenticated())
routes.onError((error, c) => {
  if (error instanceof VolumeError) {
    if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter))
    return c.json({ error: error.message }, error.status)
  }
  if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: c.req.path.endsWith('/validate') ? 'Invalid connection details' : 'Invalid folder browse parameters' }, 400)
  console.error('[volumes] Setup browse failed:', error)
  return c.json({ error: 'The volume source is temporarily unavailable. Please try again.' }, 503)
})

routes.get('/:type/folders', async c => c.json(await browseVolumeFolders(c.req.param('type'), c.req.query(), volumeViewer(c))))

routes.post('/:type/validate', async c => c.json(volumeValidationSchema.parse(await validateVolumeSource(c.req.param('type'), await c.req.json(), volumeViewer(c)))))

export default routes
