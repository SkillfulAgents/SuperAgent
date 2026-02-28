import { Hono } from 'hono'
import { cors } from 'hono/cors'
import agents from './routes/agents'
import connectedAccounts from './routes/connected-accounts'
import settings from './routes/settings'
import providers from './routes/providers'
import scheduledTasks from './routes/scheduled-tasks'
import notifications from './routes/notifications'
import proxy from './routes/proxy'
import mcpProxy from './routes/mcp-proxy'
import browser from './routes/browser'
import skillsets from './routes/skillsets'
import usage from './routes/usage'
import remoteMcps from './routes/remote-mcps'
import userSettingsRouter from './routes/user-settings'
import runtimeStatusRouter from './routes/runtime-status'
import { initializeServices } from '@shared/lib/startup'
import { isAuthMode } from '@shared/lib/auth/mode'

const app = new Hono()

// Initialize services for non-Electron environments (Vite dev server).
// In Electron, these are started in main/index.ts after SUPERAGENT_DATA_DIR is set.
if (process.type !== 'browser') {
  initializeServices().catch((error) => {
    console.error('Failed to initialize services:', error)
  })
}

// Enable CORS for all routes
app.use('*', cors())

// Mount Better Auth handler (only when AUTH_MODE is enabled)
if (isAuthMode()) {
  app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
    const { getAuth } = await import('@shared/lib/auth/index')
    return getAuth().handler(c.req.raw)
  })
}

// Mount route handlers
app.route('/api/agents', agents)
app.route('/api/connected-accounts', connectedAccounts)
app.route('/api/settings', settings)
app.route('/api/providers', providers)
app.route('/api/scheduled-tasks', scheduledTasks)
app.route('/api/notifications', notifications)
app.route('/api/proxy', proxy)
app.route('/api/mcp-proxy', mcpProxy)
app.route('/api/browser', browser)
app.route('/api/skillsets', skillsets)
app.route('/api/usage', usage)
app.route('/api/remote-mcps', remoteMcps)
app.route('/api/user-settings', userSettingsRouter)
app.route('/api/runtime-status', runtimeStatusRouter)

// Global error handler
app.onError((err, c) => {
  console.error('API Error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

export default app
