import net from 'net'

/**
 * Find an available port starting from the given port.
 * Increments by 1 until an open port is found.
 */
export async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort

  while (port < startPort + 100) {
    const isAvailable = await isPortAvailable(port)
    if (isAvailable) {
      return port
    }
    port++
  }

  throw new Error(`Could not find an available port in range ${startPort}-${startPort + 99}`)
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false)
      } else {
        resolve(false)
      }
    })

    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })

    server.listen(port, '127.0.0.1')
  })
}
