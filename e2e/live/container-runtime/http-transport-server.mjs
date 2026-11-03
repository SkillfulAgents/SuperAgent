// Deterministic transport fixture, copied only into the smoke test's own agent.
let activeSse = 0
const encoder = new TextEncoder()
const pendingReleases = new Map()

Bun.serve({
  port: Number(process.env.DASHBOARD_PORT),
  async fetch(request, server) {
    let url
    try { url = new URL(request.url) }
    catch { return new Response('Invalid URL', { status: 400 }) }
    if (url.pathname === '/socket') {
      if (server.upgrade(request, {
        headers: { 'Sec-WebSocket-Protocol': 'transport-v1' },
        data: { hostTokenPresent: request.headers.has('x-superagent-host-token') },
      })) return
      return new Response('Upgrade required', { status: 426 })
    }
    if (url.pathname === '/echo') {
      return new Response(await request.arrayBuffer(), { headers: {
        'Content-Type': 'application/octet-stream',
        'X-Probe-Method': request.method,
        'X-Probe-Query': url.search,
        'X-Host-Token-Present': String(request.headers.has('x-superagent-host-token')),
      } })
    }
    if (url.pathname === '/stats') return Response.json({ activeSse })
    if (url.pathname === '/release' && request.method === 'POST') {
      const release = pendingReleases.get(url.searchParams.get('id'))
      if (!release) return new Response('Unknown stream', { status: 404 })
      release()
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/stream') {
      let timer
      let active = true
      const releaseId = url.searchParams.get('release')
      const done = () => {
        if (!active) return
        active = false
        activeSse--
        clearTimeout(timer)
        if (releaseId) pendingReleases.delete(releaseId)
      }
      const stream = new ReadableStream({
        start(controller) {
          activeSse++
          controller.enqueue(encoder.encode('data: first\n\n'))
          const release = () => {
            if (!active) return
            controller.enqueue(encoder.encode('data: second\n\n'))
            controller.close()
            done()
          }
          if (releaseId) pendingReleases.set(releaseId, release)
          timer = setTimeout(release, 60_000)
        },
        cancel: done,
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
    }
    return new Response('<!doctype html><title>Transport fixture</title><h1>Transport fixture</h1>', {
      headers: { 'Content-Type': 'text/html' },
    })
  },
  websocket: {
    open(socket) { socket.send(JSON.stringify({ type: 'ready', ...socket.data })) },
    message(socket, message) {
      if (message === 'close-me') socket.close(4001, 'transport-closed')
      else socket.send(message)
    },
  },
})
