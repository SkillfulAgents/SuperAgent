import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { allowStreamingUpload, configureUploadTimeouts } from './streaming-upload-timeout'

const servers: Server[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function listen(authorized: boolean, delayedReader = false) {
  const server = createServer((req, res) => {
    if (authorized) allowStreamingUpload(req)
    void (async () => {
      // Metadata lookup precedes reading the body in the real adapter.
      if (delayedReader) await sleep(350)
      let data = ''
      for await (const chunk of req) data += chunk
      res.end(data)
    })().catch(() => {})
  })
  configureUploadTimeouts(server, 250)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return address.port
}

function upload(port: number, stall = false): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/api/volumes/test/file', method: 'PUT' }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    let i = 0
    req.write('start')
    const timer = setInterval(() => {
      if (stall) return
      req.write(String(i++))
      if (i === 8) { clearInterval(timer); req.end('end') }
    }, 65)
    req.once('close', () => clearInterval(timer))
  })
}

describe('streaming volume upload deadlines', () => {
  it('allows a progressing authorized upload beyond the ordinary deadline without draining its body early', async () => {
    expect(await upload(await listen(true, true))).toEqual({ status: 200, body: 'start01234567end' })
  })

  it('retains the absolute deadline unless the authenticated route opts in', async () => {
    const result = await upload(await listen(false))
    expect([0, 408]).toContain(result.status)
  })

  it('still terminates an authorized upload that stops sending data', async () => {
    const result = await upload(await listen(true), true)
    expect([0, 408]).toContain(result.status)
  })
})
