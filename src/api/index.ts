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
import commonMcpServers from './routes/common-mcp-servers'
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
const trustedOrigins = process.env.TRUSTED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean)
app.use('*', cors(trustedOrigins?.length ? { origin: trustedOrigins } : undefined))

// Simple rate limiter for auth endpoints
const authAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15 minutes

if (isAuthMode()) {
  app.use('/api/auth/*', async (c, next) => {
    // Only rate-limit POST requests (sign-in, sign-up attempts)
    if (c.req.method !== 'POST') return next()

    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
    const now = Date.now()
    const entry = authAttempts.get(ip)

    if (entry && now < entry.resetAt) {
      if (entry.count >= RATE_LIMIT_MAX) {
        return c.json({ error: 'Too many attempts. Please try again later.' }, 429)
      }
      entry.count++
    } else {
      authAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    }

    // Clean up old entries periodically
    if (authAttempts.size > 1000) {
      for (const [key, val] of authAttempts) {
        if (now >= val.resetAt) authAttempts.delete(key)
      }
    }

    return next()
  })
}

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
app.route('/api/common-mcp-servers', commonMcpServers)
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
