import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getConfiguredLlmClient } from '@shared/lib/llm-provider/helpers'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'

const llm = new Hono()

llm.use('*', Authenticated())

const DEFAULT_MODEL = 'claude-sonnet-4-6'

// Simple rate limiter: 100 requests per minute
const requestCounts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 100
const RATE_WINDOW = 60_000

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = requestCounts.get(key)
  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT) return false
    entry.count++
  } else {
    requestCounts.set(key, { count: 1, resetAt: now + RATE_WINDOW })
  }
  // Periodic cleanup
  if (requestCounts.size > 100) {
    for (const [k, v] of requestCounts) {
      if (now >= v.resetAt) requestCounts.delete(k)
    }
  }
  return true
}

// GET /api/llm/config
llm.get('/config', (c) => {
  const provider = getActiveLlmProvider()
  return c.json({
    configured: provider.getApiKeyStatus().isConfigured,
    defaultModel: DEFAULT_MODEL,
    provider: provider.id,
  })
})

// POST /api/llm/v1/messages — matches the path the Anthropic SDK sends
llm.post('/v1/messages', async (c) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
  if (!checkRateLimit(ip)) {
    return c.json({ error: 'Too many LLM requests. Please slow down.' }, 429)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // Sanitize: strip fields that could override auth
  delete body.apiKey
  delete body.authToken
  delete body.baseURL
  delete body.api_key
  delete body.auth_token
  delete body.base_url

  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: 'Missing required field: messages' }, 400)
  }

  const model = (body.model as string) || DEFAULT_MODEL
  const stream = !!body.stream

  let client
  try {
    client = getConfiguredLlmClient()
  } catch {
    return c.json({ error: 'LLM provider not configured. Check Gamut settings.' }, 503)
  }

  try {
    if (stream) {
      const response = await client.messages.create({
        ...body,
        model,
        stream: true,
      } as Parameters<typeof client.messages.create>[0])

      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            try {
              for await (const event of response as AsyncIterable<{ type: string }>) {
                const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
                controller.enqueue(encoder.encode(frame))
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Stream error'
              const errorFrame = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: msg } })}\n\n`
              controller.enqueue(encoder.encode(errorFrame))
            }
            controller.close()
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        },
      )
    } else {
      const message = await client.messages.create({
        ...body,
        model,
      } as Parameters<typeof client.messages.create>[0])
      return c.json(message)
    }
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string }
    const status = (error.status || 500) as 400
    const message = error.message || 'LLM request failed'
    return c.json({ error: message }, status)
  }
})

export default llm
