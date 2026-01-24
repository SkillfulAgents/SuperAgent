import { exec, execSync, spawn } from 'child_process'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import * as fs from 'fs'
import net from 'net'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  ContainerSession,
  CreateSessionOptions,
  StartOptions,
  StreamMessage,
} from './types'
import { getAgentWorkspaceDir } from '@/lib/config/data-dir'
import { getSettings, getEffectiveAnthropicApiKey } from '@/lib/config/settings'

const execAsync = promisify(exec)

/**
 * Check if a command is available on the system.
 */
export async function checkCommandAvailable(command: string): Promise<boolean> {
  try {
    await execAsync(`${command} --version`)
    return true
  } catch {
    return false
  }
}

const AGENT_CONTAINER_PATH = './agent-container'
const CONTAINER_INTERNAL_PORT = 3000
const BASE_PORT = 4000

/**
 * Base class for OCI-compatible container runtimes (Docker, Podman, etc.)
 * Subclasses should override getRunnerCommand() to specify the CLI command.
 */
export abstract class BaseContainerClient extends EventEmitter implements ContainerClient {
  protected config: ContainerConfig
  private wsConnections: Map<string, WebSocket> = new Map()

  constructor(config: ContainerConfig) {
    super()
    this.config = config
  }

  /**
   * Returns the CLI command for this container runtime (e.g., 'docker', 'podman')
   */
  protected abstract getRunnerCommand(): string

  /**
   * Returns any additional flags needed for the run command.
   * Subclasses can override this to add runtime-specific flags.
   */
  protected getAdditionalRunFlags(): string {
    return ''
  }

  /**
   * Returns resource limit flags for the container.
   * Subclasses can override if the runtime uses different flag syntax.
   */
  protected getResourceFlags(cpu: number, memory: string): string {
    return `--cpus=${cpu} --memory=${memory}`
  }

  private getContainerName(): string {
    return `superagent-${this.config.agentId}`
  }

  async getInfo(): Promise<ContainerInfo> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execAsync(
        `${runner} inspect --format='{{.State.Running}}|{{range $p, $conf := .NetworkSettings.Ports}}{{if eq $p "${CONTAINER_INTERNAL_PORT}/tcp"}}{{(index $conf 0).HostPort}}{{end}}{{end}}' ${containerName} 2>/dev/null`
      )
      const [running, port] = stdout.trim().split('|')
      return {
        status: running === 'true' ? 'running' : 'stopped',
        port: port ? parseInt(port, 10) : null,
      }
    } catch {
      return { status: 'stopped', port: null }
    }
  }

  private async findAvailablePort(): Promise<number> {
    const usedPorts = await this.getUsedPorts()

    let port = BASE_PORT
    while (usedPorts.has(port) || !(await this.isPortAvailable(port))) {
      port++
    }
    return port
  }

  private async getUsedPorts(): Promise<Set<number>> {
    const usedPorts = new Set<number>()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execAsync(
        `${runner} ps --format '{{.Ports}}' 2>/dev/null`
      )

      const portRegex = /:(\d+)->/g
      let match
      while ((match = portRegex.exec(stdout)) !== null) {
        usedPorts.add(parseInt(match[1], 10))
      }
    } catch {
      // If command fails, continue with empty set
    }
    return usedPorts
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

  async start(options?: StartOptions): Promise<void> {
    const info = await this.getInfo()
    if (info.status === 'running') {
      console.log(`Container ${this.getContainerName()} is already running on port ${info.port}`)
      return
    }

    try {
      const settings = getSettings()
      const runner = this.getRunnerCommand()
      const image = settings.container.agentImage
      const { cpu, memory } = settings.container.resourceLimits

      // Ensure image exists (build if not)
      await this.ensureImageExists()

      // Ensure workspace directory exists for persistent storage
      const workspaceDir = getAgentWorkspaceDir(this.config.agentId)
      fs.mkdirSync(workspaceDir, { recursive: true })

      // Find an available port
      const port = await this.findAvailablePort()

      // Build run command with additional env vars from options
      const envFlags = this.buildEnvFlags(options?.envVars)
      const containerName = this.getContainerName()

      // Remove existing container if exists (might be stopped)
      await execAsync(`${runner} rm -f ${containerName} 2>/dev/null || true`)

      // Build resource limit flags
      const resourceFlags = this.getResourceFlags(cpu, memory)
      const additionalFlags = this.getAdditionalRunFlags()

      // Start container with volume mount for persistent workspace
      const { stdout } = await execAsync(
        `${runner} run -d \
          --name ${containerName} \
          -p ${port}:${CONTAINER_INTERNAL_PORT} \
          -v "${workspaceDir}:/workspace" \
          ${resourceFlags} \
          ${additionalFlags} \
          ${envFlags} \
          ${image}`
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
      const runner = this.getRunnerCommand()
      const containerName = this.getContainerName()
      await execAsync(`${runner} stop ${containerName} 2>/dev/null || true`)
      await execAsync(`${runner} rm ${containerName} 2>/dev/null || true`)

      console.log(`Stopped container ${containerName}`)
    } catch (error: any) {
      console.error('Failed to stop container:', error)
      this.emit('error', error)
      throw error
    }
  }

  stopSync(): void {
    try {
      // Close all WebSocket connections
      for (const ws of this.wsConnections.values()) {
        ws.close()
      }
      this.wsConnections.clear()

      // Stop and remove container by name synchronously
      const runner = this.getRunnerCommand()
      const containerName = this.getContainerName()
      try {
        execSync(`${runner} stop ${containerName}`, { stdio: 'pipe', timeout: 10000 })
      } catch {
        // Container might not exist, ignore
      }
      try {
        execSync(`${runner} rm ${containerName}`, { stdio: 'pipe', timeout: 5000 })
      } catch {
        // Container might not exist, ignore
      }

      console.log(`Stopped container ${containerName} (sync)`)
    } catch (error) {
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

  /**
   * Returns the base URL for HTTP requests to the container.
   * Subclasses can override for different networking (e.g., cloud containers).
   */
  protected getBaseUrl(port: number): string {
    return `http://localhost:${port}`
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const port = await this.getPortOrThrow()
    const baseUrl = this.getBaseUrl(port)
    const url = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`
    return fetch(url, init)
  }

  async createSession(options: CreateSessionOptions): Promise<ContainerSession> {
    const port = await this.getPortOrThrow()

    const response = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metadata: options.metadata,
        systemPrompt: options.systemPrompt,
        availableEnvVars: options.availableEnvVars,
        initialMessage: options.initialMessage,
      }),
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

  async interruptSession(sessionId: string): Promise<boolean> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `http://localhost:${port}/sessions/${sessionId}/interrupt`,
      { method: 'POST' }
    )

    return response.ok
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
    const setupWebSocket = async () => {
      const port = await this.getPortOrThrow()

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

    setupWebSocket().catch((error) => {
      console.error('Failed to set up WebSocket:', error)
      this.emit('error', error)
    })

    return () => {
      const ws = this.wsConnections.get(sessionId)
      if (ws) {
        ws.close()
        this.wsConnections.delete(sessionId)
      }
    }
  }

  private async ensureImageExists(): Promise<void> {
    const settings = getSettings()
    const runner = this.getRunnerCommand()
    const image = settings.container.agentImage

    try {
      await execAsync(`${runner} image inspect ${image}`)
      console.log(`Container image ${image} found`)
    } catch {
      console.log(`Building container image ${image}...`)

      const buildProcess = spawn(
        runner,
        ['build', '-t', image, AGENT_CONTAINER_PATH],
        { stdio: 'inherit' }
      )

      await new Promise<void>((resolve, reject) => {
        buildProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`Container image ${image} built successfully`)
            resolve()
          } else {
            reject(new Error(`Container build failed with code ${code}`))
          }
        })
        buildProcess.on('error', reject)
      })
    }
  }

  private buildEnvFlags(additionalEnvVars?: Record<string, string>): string {
    const envVars: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: getEffectiveAnthropicApiKey(),
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ...this.config.envVars,
      ...additionalEnvVars,
    }

    return Object.entries(envVars)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => {
        // Escape single quotes for shell safety, then wrap in single quotes
        const escaped = value!.replace(/'/g, "'\\''")
        return `-e ${key}='${escaped}'`
      })
      .join(' ')
  }
}
