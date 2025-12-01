import { exec, execSync, spawn } from 'child_process'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import net from 'net'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  ContainerSession,
  StreamMessage,
} from './types'

const execAsync = promisify(exec)

const DOCKER_IMAGE = 'superagent-container:latest'
const AGENT_CONTAINER_PATH = './agent-container'
const CONTAINER_INTERNAL_PORT = 3000
const DATA_DIR = './data/agents'
const BASE_PORT = 4000

export class LocalDockerContainerClient extends EventEmitter implements ContainerClient {
  private config: ContainerConfig
  private wsConnections: Map<string, WebSocket> = new Map()

  constructor(config: ContainerConfig) {
    super()
    this.config = config
  }

  private getContainerName(): string {
    return `superagent-${this.config.agentId}`
  }

  // Query Docker for container status and port (single source of truth)
  async getInfo(): Promise<ContainerInfo> {
    const containerName = this.getContainerName()
    try {
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Running}}|{{range $p, $conf := .NetworkSettings.Ports}}{{if eq $p "${CONTAINER_INTERNAL_PORT}/tcp"}}{{(index $conf 0).HostPort}}{{end}}{{end}}' ${containerName} 2>/dev/null`
      )
      const [running, port] = stdout.trim().split('|')
      return {
        status: running === 'true' ? 'running' : 'stopped',
        port: port ? parseInt(port, 10) : null,
      }
    } catch {
      // Container doesn't exist
      return { status: 'stopped', port: null }
    }
  }

  // Find an available port
  private async findAvailablePort(): Promise<number> {
    let port = BASE_PORT
    while (!(await this.isPortAvailable(port))) {
      port++
    }
    return port
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close()
        resolve(true)
      })
      server.listen(port, '127.0.0.1')
    })
  }

  async start(): Promise<void> {
    const info = await this.getInfo()
    if (info.status === 'running') {
      console.log(`Container ${this.getContainerName()} is already running on port ${info.port}`)
      return
    }

    try {
      // Ensure image exists (build if not)
      await this.ensureImageExists()

      // Ensure workspace directory exists for persistent storage
      const workspaceDir = path.resolve(DATA_DIR, this.config.agentId, 'workspace')
      fs.mkdirSync(workspaceDir, { recursive: true })

      // Find an available port
      const port = await this.findAvailablePort()

      // Build docker run command
      const envFlags = this.buildEnvFlags()
      const containerName = this.getContainerName()

      // Remove existing container if exists (might be stopped)
      await execAsync(`docker rm -f ${containerName} 2>/dev/null || true`)

      // Start container with volume mount for persistent workspace
      const { stdout } = await execAsync(
        `docker run -d \
          --name ${containerName} \
          -p ${port}:${CONTAINER_INTERNAL_PORT} \
          -v "${workspaceDir}:/workspace" \
          ${envFlags} \
          ${DOCKER_IMAGE}`
      )

      console.log(`Started container ${stdout.trim()} on port ${port}`)

      // Wait for container to be healthy
      const healthy = await this.waitForHealthy(60000)
      if (!healthy) {
        throw new Error('Container failed to become healthy')
      }

      console.log(`Container ${containerName} is now running on port ${port}`)
    } catch (error: any) {
      console.error('Failed to start container:', error)
      this.emit('error', error)
      throw error
    }
  }

  async stop(): Promise<void> {
    try {
      // Close all WebSocket connections
      for (const ws of this.wsConnections.values()) {
        ws.close()
      }
      this.wsConnections.clear()

      // Stop and remove container by name
      const containerName = this.getContainerName()
      await execAsync(`docker stop ${containerName} 2>/dev/null || true`)
      await execAsync(`docker rm ${containerName} 2>/dev/null || true`)

      console.log(`Stopped container ${containerName}`)
    } catch (error: any) {
      console.error('Failed to stop container:', error)
      this.emit('error', error)
      throw error
    }
  }

  // Synchronous stop for exit handlers where async isn't available
  stopSync(): void {
    try {
      // Close all WebSocket connections
      for (const ws of this.wsConnections.values()) {
        ws.close()
      }
      this.wsConnections.clear()

      // Stop and remove container by name synchronously
      const containerName = this.getContainerName()
      try {
        execSync(`docker stop ${containerName}`, { stdio: 'pipe', timeout: 10000 })
      } catch {
        // Container might not exist, ignore
      }
      try {
        execSync(`docker rm ${containerName}`, { stdio: 'pipe', timeout: 5000 })
      } catch {
        // Container might not exist, ignore
      }

      console.log(`Stopped container ${containerName} (sync)`)
    } catch (error) {
      // Best effort - ignore errors during sync cleanup
      console.error('Failed to stop container (sync):', error)
    }
  }

  async waitForHealthy(timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 1000

    while (Date.now() - startTime < timeoutMs) {
      if (await this.isHealthy()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    return false
  }

  async isHealthy(): Promise<boolean> {
    const info = await this.getInfo()
    if (info.status !== 'running' || !info.port) {
      return false
    }
    try {
      const response = await fetch(`http://localhost:${info.port}/health`)
      return response.ok
    } catch {
      return false
    }
  }

  private async getPortOrThrow(): Promise<number> {
    const info = await this.getInfo()
    if (info.status !== 'running' || !info.port) {
      throw new Error('Container is not running')
    }
    return info.port
  }

  async createSession(metadata?: Record<string, any>): Promise<ContainerSession> {
    const port = await this.getPortOrThrow()

    const response = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata }),
    })

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`)
    }

    return response.json()
  }

  async getSession(sessionId: string): Promise<ContainerSession | null> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `http://localhost:${port}/sessions/${sessionId}`
    )

    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.statusText}`)
    }

    return response.json()
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const port = await this.getPortOrThrow()

    // Close WebSocket if exists
    const ws = this.wsConnections.get(sessionId)
    if (ws) {
      ws.close()
      this.wsConnections.delete(sessionId)
    }

    const response = await fetch(
      `http://localhost:${port}/sessions/${sessionId}`,
      { method: 'DELETE' }
    )

    return response.ok
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `http://localhost:${port}/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`)
    }
  }

  async getMessages(sessionId: string): Promise<any[]> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `http://localhost:${port}/sessions/${sessionId}/messages`
    )

    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.statusText}`)
    }

    return response.json()
  }

  subscribeToStream(
    sessionId: string,
    callback: (message: StreamMessage) => void
  ): () => void {
    // We need the port synchronously for WebSocket, so we'll get it and set up
    // the connection. If the container isn't running, this will fail.
    const setupWebSocket = async () => {
      const port = await this.getPortOrThrow()

      // Close existing connection for this session
      const existing = this.wsConnections.get(sessionId)
      if (existing) {
        existing.close()
      }

      const ws = new WebSocket(
        `ws://localhost:${port}/sessions/${sessionId}/stream`
      )

      ws.on('open', () => {
        console.log(`WebSocket connected for session ${sessionId}`)
      })

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          const streamMessage: StreamMessage = {
            type: message.type,
            content: message,
            timestamp: new Date(message.timestamp || Date.now()),
            sessionId,
          }
          callback(streamMessage)
          // Also emit for the message persister
          this.emit('message', sessionId, message)
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error)
        }
      })

      ws.on('error', (error) => {
        console.error(`WebSocket error for session ${sessionId}:`, error)
        this.emit('error', error)
      })

      ws.on('close', () => {
        console.log(`WebSocket closed for session ${sessionId}`)
        this.wsConnections.delete(sessionId)
      })

      this.wsConnections.set(sessionId, ws)
    }

    // Start the WebSocket setup
    setupWebSocket().catch((error) => {
      console.error('Failed to set up WebSocket:', error)
      this.emit('error', error)
    })

    // Return unsubscribe function
    return () => {
      const ws = this.wsConnections.get(sessionId)
      if (ws) {
        ws.close()
        this.wsConnections.delete(sessionId)
      }
    }
  }

  // Private methods

  private async ensureImageExists(): Promise<void> {
    try {
      // Check if image exists
      await execAsync(`docker image inspect ${DOCKER_IMAGE}`)
      console.log(`Docker image ${DOCKER_IMAGE} found`)
    } catch {
      // Image doesn't exist, build it
      console.log(`Building Docker image ${DOCKER_IMAGE}...`)

      const buildProcess = spawn(
        'docker',
        ['build', '-t', DOCKER_IMAGE, AGENT_CONTAINER_PATH],
        { stdio: 'inherit' }
      )

      await new Promise<void>((resolve, reject) => {
        buildProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`Docker image ${DOCKER_IMAGE} built successfully`)
            resolve()
          } else {
            reject(new Error(`Docker build failed with code ${code}`))
          }
        })
        buildProcess.on('error', reject)
      })
    }
  }

  private buildEnvFlags(): string {
    const envVars: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      // Store Claude session data in /workspace so it persists with the volume mount
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ...this.config.envVars,
    }

    return Object.entries(envVars)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `-e ${key}="${value}"`)
      .join(' ')
  }
}
