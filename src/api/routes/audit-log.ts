import { Hono } from 'hono'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { queryAuditLog, AUDIT_EVENT_MAP, getDistinctAuditUsers } from '@shared/lib/services/audit-log-service'

const auditLogRouter = new Hono()

auditLogRouter.use('*', Authenticated(), IsAdmin())

auditLogRouter.get('/', async (c) => {
  try {
    const result = await queryAuditLog({
      object: c.req.query('object') || undefined,
      action: c.req.query('action') || undefined,
      userId: c.req.query('userId') || undefined,
      limit: parseInt(c.req.query('limit') || '50', 10) || 50,
      offset: parseInt(c.req.query('offset') || '0', 10) || 0,
    })
    return c.json(result)
  } catch (error) {
    console.error('Failed to fetch audit log:', error)
    return c.json({ error: 'Failed to fetch audit log' }, 500)
  }
})

auditLogRouter.get('/filters', async (c) => {
  const users = await getDistinctAuditUsers()
  return c.json({ eventMap: AUDIT_EVENT_MAP, users })
})

export default auditLogRouter
