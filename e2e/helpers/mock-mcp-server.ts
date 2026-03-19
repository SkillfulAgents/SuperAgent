import * as http from 'http'

/**
 * A minimal mock MCP server that responds to JSON-RPC initialize and tools/list requests.
 * Used in E2E tests to simulate a real remote MCP server connection.
 */
export interface MockMcpServer {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startMockMcpServer(port = 9876): Promise<MockMcpServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }

      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const rpc = JSON.parse(body)

          res.setHeader('Content-Type', 'application/json')

          if (rpc.method === 'initialize') {
            res.writeHead(200)
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'E2E Test MCP', version: '1.0.0' },
              },
            }))
          } else if (rpc.method === 'notifications/initialized') {
            res.writeHead(200)
            res.end()
          } else if (rpc.method === 'tools/list') {
            res.writeHead(200)
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                tools: [
                  {
                    name: 'hello_world',
                    description: 'Returns a greeting message',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', description: 'Name to greet' },
                      },
                    },
                  },
                  {
                    name: 'get_weather',
                    description: 'Gets the current weather for a city',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        city: { type: 'string', description: 'City name' },
                      },
                    },
                  },
                ],
              },
            }))
          } else {
            res.writeHead(200)
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32601, message: 'Method not found' },
            }))
          }
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }
      })
    })

    server.listen(port, () => {
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })

    server.on('error', reject)
  })
}
