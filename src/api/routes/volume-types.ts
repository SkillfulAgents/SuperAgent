import { volumeValidationSchema } from '@shared/lib/volumes/volume-validation-schema'
import { Hono } from 'hono'
import { z } from 'zod'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { browseVolumeFolders, createVolumeFolder, validateVolumeSource } from '@shared/lib/volumes/volume-factory'
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
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    const what = c.req.path.endsWith('/validate') ? 'Invalid connection details' : c.req.method === 'POST' ? 'Invalid new folder details' : 'Invalid folder browse parameters'
    return c.json({ error: what }, 400)
  }
  console.error('[volumes] Setup call failed:', error)
  return c.json({ error: 'The drive source is temporarily unavailable. Please try again.' }, 503)
})

routes.get('/:type/folders', async c => c.json(await browseVolumeFolders(c.req.param('type'), c.req.query(), volumeViewer(c))))

routes.post('/:type/folders', async c => c.json(await createVolumeFolder(c.req.param('type'), await c.req.json(), volumeViewer(c))))

routes.post('/:type/validate', async c => c.json(volumeValidationSchema.parse(await validateVolumeSource(c.req.param('type'), await c.req.json(), volumeViewer(c)))))

export default routes
