import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import net from 'net'
import { findAvailablePort } from './find-port'

vi.mock('net')

describe('findAvailablePort', () => {
  let mockServer: {
    once: ReturnType<typeof vi.fn>
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockServer = {
      once: vi.fn(),
      listen: vi.fn(),
      close: vi.fn(),
    }
    vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns the starting port when it is available', async () => {
    mockServer.once.mockImplementation((event: string, callback: () => void) => {
      if (event === 'listening') {
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    const port = await findAvailablePort(3000)

    expect(port).toBe(3000)
    expect(mockServer.listen).toHaveBeenCalledWith(3000)
  })

  it('skips unavailable ports and returns the first available one', async () => {
    let callCount = 0

    mockServer.once.mockImplementation((event: string, callback: (err?: NodeJS.ErrnoException) => void) => {
      if (event === 'error' && callCount < 2) {
        // First two ports are in use
        setTimeout(() => callback({ code: 'EADDRINUSE' } as NodeJS.ErrnoException), 0)
      } else if (event === 'listening' && callCount >= 2) {
        // Third port is available
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    mockServer.listen.mockImplementation(() => {
      callCount++
      return mockServer
    })

    const port = await findAvailablePort(3000)

    expect(port).toBe(3002)
    expect(mockServer.listen).toHaveBeenCalledTimes(3)
  })

  it('throws an error when no ports are available within the range', async () => {
    mockServer.once.mockImplementation((event: string, callback: (err?: NodeJS.ErrnoException) => void) => {
      if (event === 'error') {
        setTimeout(() => callback({ code: 'EADDRINUSE' } as NodeJS.ErrnoException), 0)
      }
      return mockServer
    })

    await expect(findAvailablePort(3000)).rejects.toThrow(
      'Could not find an available port in range 3000-3099'
    )

    expect(mockServer.listen).toHaveBeenCalledTimes(100)
  })

  it('treats non-EADDRINUSE errors as port unavailable', async () => {
    let callCount = 0

    mockServer.once.mockImplementation((event: string, callback: (err?: NodeJS.ErrnoException) => void) => {
      if (event === 'error' && callCount < 1) {
        // First port has a different error
        setTimeout(() => callback({ code: 'EACCES' } as NodeJS.ErrnoException), 0)
      } else if (event === 'listening' && callCount >= 1) {
        // Second port is available
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    mockServer.listen.mockImplementation(() => {
      callCount++
      return mockServer
    })

    const port = await findAvailablePort(3000)

    expect(port).toBe(3001)
  })

  it('listens without specifying host to match serve() binding', async () => {
    mockServer.once.mockImplementation((event: string, callback: () => void) => {
      if (event === 'listening') {
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    await findAvailablePort(8080)

    expect(mockServer.listen).toHaveBeenCalledWith(8080)
  })

  it('properly closes the server after checking availability', async () => {
    mockServer.once.mockImplementation((event: string, callback: () => void) => {
      if (event === 'listening') {
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    await findAvailablePort(3000)

    expect(mockServer.close).toHaveBeenCalled()
  })

  it('checks ports sequentially starting from startPort', async () => {
    const listenedPorts: number[] = []
    let callCount = 0

    mockServer.once.mockImplementation((event: string, callback: (err?: NodeJS.ErrnoException) => void) => {
      if (event === 'error' && callCount < 5) {
        setTimeout(() => callback({ code: 'EADDRINUSE' } as NodeJS.ErrnoException), 0)
      } else if (event === 'listening' && callCount >= 5) {
        mockServer.close.mockImplementation((cb: () => void) => cb())
        setTimeout(() => callback(), 0)
      }
      return mockServer
    })

    mockServer.listen.mockImplementation((port: number) => {
      listenedPorts.push(port)
      callCount++
      return mockServer
    })

    const port = await findAvailablePort(5000)

    expect(port).toBe(5005)
    expect(listenedPorts).toEqual([5000, 5001, 5002, 5003, 5004, 5005])
  })
})
