import { Hono } from 'hono'
import { cors } from 'hono/cors'
import agents from './routes/agents'
import connectedAccounts from './routes/connected-accounts'
import settings from './routes/settings'
import providers from './routes/providers'

const app = new Hono()

// Enable CORS for all routes
app.use('*', cors())

// Mount route handlers
app.route('/api/agents', agents)
app.route('/api/connected-accounts', connectedAccounts)
app.route('/api/settings', settings)
app.route('/api/providers', providers)

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
