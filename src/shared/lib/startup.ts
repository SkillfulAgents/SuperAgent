import { containerManager } from './container/container-manager'
import { taskScheduler } from './scheduler/task-scheduler'
import { autoSleepMonitor } from './scheduler/auto-sleep-monitor'
import { listAgents } from './services/agent-service'
import { isAuthMode } from './auth/mode'
import { validateAuthModeStartup } from './auth/startup-validation'

/**
 * Initialize all background services.
 *
 * Called from two places:
 * - api/index.ts: for non-Electron environments (Vite dev server, standalone web server)
 * - main/index.ts: for Electron, after SUPERAGENT_DATA_DIR is set
 */
export async function initializeServices() {
  // Validate auth mode startup requirements before anything else
  if (isAuthMode()) {
    await validateAuthModeStartup()
  }
  // Initialize container manager with all agents
  const agents = await listAgents()
  const slugs = agents.map((a) => a.slug)
  await containerManager.initializeAgents(slugs)

  // Check/pull container image (non-blocking)
  containerManager.ensureImageReady().catch((error) => {
    console.error('Failed to ensure image ready:', error)
  })

  // Start container status sync and health monitor
  containerManager.startStatusSync()
  containerManager.startHealthMonitor()

  // Start task scheduler
  taskScheduler.start().catch((error) => {
    console.error('Failed to start task scheduler:', error)
  })

  // Start auto-sleep monitor
  autoSleepMonitor.start().catch((error) => {
    console.error('Failed to start auto-sleep monitor:', error)
  })
}
