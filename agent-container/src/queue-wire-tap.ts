import http from 'http'
import fs from 'fs'
import path from 'path'

export const STEER_WRAPPER = 'The user sent a new message while you were working'
export const QUEUE_WIRE_TAP_PORT = 18765
const TAP_ORIGIN = `http://127.0.0.1:${QUEUE_WIRE_TAP_PORT}`
const LOG_DIR = '/workspace/.superagent-debug'
const LOG_FILE = path.join(LOG_DIR, 'wire.jsonl')

const queuedTexts = new Set<string>()
let listening = false

export type WireInspect = {
  hasSteerWrapper: boolean
  queuedHits: string[]
  userTextPreviews: string[]
}

export function noteQueuedWireText(text: string): void {
  const trimmed = text.trim()
  if (trimmed) queuedTexts.add(trimmed)
}

export function inspectMessagesBody(raw: string, queued: Iterable<string>): WireInspect {
  const queuedList = [...queued].filter(Boolean)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { hasSteerWrapper: raw.includes(STEER_WRAPPER), queuedHits: hitsIn(raw, queuedList), userTextPreviews: [] }
  }
  const strings = collectStrings(parsed)
  const blob = strings.join('\n')
  return {
    hasSteerWrapper: blob.includes(STEER_WRAPPER),
    queuedHits: hitsIn(blob, queuedList),
    userTextPreviews: userTextPreviews(parsed),
  }
}

export function startQueueWireTapFromEnv(): void {
  const upstream = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!upstream) {
    console.warn('[queue-debug] wire tap skipped: ANTHROPIC_BASE_URL is unset')
    return
  }
  ensureQueueWireTapSync(upstream)
}

export function ensureQueueWireTapSync(upstream: string): string {
  if (upstream.startsWith(TAP_ORIGIN)) return TAP_ORIGIN
  if (!listening) {
    listening = true
    startTap(upstream.replace(/\/$/, ''))
  }
  return TAP_ORIGIN
}

function hitsIn(blob: string, queued: string[]): string[] {
  return queued.filter((text) => blob.includes(text))
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
  return out
}

function userTextPreviews(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return []
  const messages = (parsed as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  const out: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if ((message as { role?: string }).role !== 'user') continue
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') out.push(content.slice(0, 80))
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        if ((part as { type?: string }).type !== 'text') continue
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') out.push(text.slice(0, 80))
      }
    }
  }
  return out.slice(-8)
}

function startTap(upstream: string): void {
  const server = http.createServer((req, res) => {
    void forward(req, res, upstream)
  })
  server.listen(QUEUE_WIRE_TAP_PORT, '127.0.0.1', () => {
    console.log(`[queue-debug] wire tap ${TAP_ORIGIN} -> ${upstream}`)
  })
  server.on('error', (err) => {
    listening = false
    console.warn('[queue-debug] wire tap listen failed', err)
  })
}

async function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: string,
): Promise<void> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of req) chunks.push(chunk as Buffer)
  } catch (err) {
    console.warn('[queue-debug] wire tap failed to read request', err)
    res.writeHead(400)
    res.end('bad request')
    return
  }
  const body = Buffer.concat(chunks)
  const url = req.url ?? '/'
  if (req.method === 'POST' && url.includes('/v1/messages')) {
    logWire(url, body.toString('utf8'))
  }
  const headers = { ...req.headers }
  delete headers.host
  delete headers['content-length']
  try {
    const upstreamRes = await fetch(upstream + url, {
      method: req.method,
      headers: headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      duplex: 'half',
    })
    const respHeaders = Object.fromEntries(upstreamRes.headers)
    delete respHeaders['content-encoding']
    delete respHeaders['content-length']
    res.writeHead(upstreamRes.status, respHeaders)
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) res.write(chunk)
    }
    res.end()
  } catch (err) {
    console.warn('[queue-debug] wire tap forward failed', err)
    res.writeHead(502)
    res.end(err instanceof Error ? err.message : 'forward failed')
  }
}

function logWire(url: string, raw: string): void {
  const inspect = inspectMessagesBody(raw, queuedTexts)
  const record = {
    t: new Date().toISOString(),
    url,
    hasSteerWrapper: inspect.hasSteerWrapper,
    queuedHits: inspect.queuedHits,
    userTextPreviews: inspect.userTextPreviews,
    queuedKnown: [...queuedTexts],
  }
  console.log('[queue-debug] wire', record)
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
  } catch (err) {
    console.warn('[queue-debug] failed to write wire.jsonl', err)
  }
}
