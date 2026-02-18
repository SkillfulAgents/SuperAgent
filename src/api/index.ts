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
import { taskScheduler } from '@shared/lib/scheduler/task-scheduler'

const app = new Hono()

// Start the task scheduler (singleton pattern handles HMR/multiple imports)
// This ensures the scheduler runs in both development (Vite) and production (server.ts)
taskScheduler.start().catch((error) => {
  console.error('Failed to start task scheduler:', error)
})

// Enable CORS for all routes
app.use('*', cors())

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
