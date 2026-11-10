import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.fn()
const validateAuth = vi.fn().mockResolvedValue(undefined)
const listAgents = vi.fn().mockResolvedValue([])
const initializeAgents = vi.fn().mockResolvedValue(undefined)
const watchWebhookRelay = vi.fn((_relay: { snapshot(): { available: boolean } }) => () => {})
// A relay that reports whether startup has started it.
const relayState = vi.hoisted(() => ({ started: false }))
// What shutdown released, in order.
const released = vi.hoisted(() => [] as string[])
vi.mock('./webhook-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./webhook-relay')>()),
  getWebhookRelay: () => ({
    id: 'webhook-relay',
    phase: 'eager',
    critical: true,
    start: () => { relayState.started = true },
    stop: () => { relayState.started = false; released.push('webhook-relay') },
    snapshot: () => ({ available: relayState.started, unavailableReason: relayState.started ? null : 'stopped' }),
  }),
}))
const ensureImageReady = vi.fn().mockResolvedValue(undefined)
const taskSchedulerStart = vi.fn().mockResolvedValue(undefined)
const triggerManagerStart = vi.fn().mockResolvedValue(undefined)
const platformNotificationsStart = vi.fn().mockResolvedValue(undefined)
const chatIntegrationStart = vi.fn().mockResolvedValue(undefined)
const getSettings = vi.fn().mockReturnValue({})
const getPlatformAccessToken = vi.fn().mockReturnValue(null)
const isAuthMode = vi.fn().mockReturnValue(true)
const clearPendingApprovalBans = vi.fn()
const ensureManagedPlatformConnection = vi.fn(async () => {})
vi.mock('./llm-provider/connection-settings', () => ({
  ensureManagedPlatformConnection: () => ensureManagedPlatformConnection(),
}))

vi.mock('./services/skillset-reconcile', () => ({
  reconcileSkillsetConfigsForCurrentAuth: () => reconcile(),
}))
vi.mock('./auth/startup-validation', () => ({
  validateAuthModeStartup: () => validateAuth(),
}))
vi.mock('./auth/mode', () => ({
  isAuthMode: () => isAuthMode(),
}))
vi.mock('./auth/clear-pending-approval-bans', () => ({
  clearPendingApprovalBans: () => clearPendingApprovalBans(),
}))
// Which agents exist is settled when the database is opened (the data
// migration imports the directories); startup itself never touches the
// catalog. Any use of it here is a regression.
vi.mock('./agent-actor/agent-catalog', () => ({
  agentCatalog: new Proxy({}, {
    get(_target, property) {
      throw new Error(`startup used agentCatalog.${String(property)}`)
    },
  }),
}))
vi.mock('./services/agent-service', () => ({
  listAgents: () => listAgents(),
}))
vi.mock('./container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      initializeAgents: (...args: unknown[]) => initializeAgents(...args),
      watchWebhookRelay: (relay: { snapshot(): { available: boolean } }) => watchWebhookRelay(relay),
      ensureImageReady: () => ensureImageReady(),
      startStatusSync: vi.fn(),
      startHealthMonitor: vi.fn(),
      onBeforeContainerStop: null,
      stopStatusSync: () => { released.push('status-sync') },
      stopHealthMonitor: () => { released.push('health-monitor') },
      stopAll: async () => { released.push('containers') },
      clearClients: vi.fn(),
    }),
  }
})
vi.mock('./config/settings', () => ({
  getSettings: () => getSettings(),
}))
vi.mock('./services/platform-auth-service', () => ({
  getPlatformAccessToken: () => getPlatformAccessToken(),
}))
vi.mock('./platform-attribution', () => ({
  decodeOrgIdFromToken: () => null,
  installPlatformFetchInterceptor: vi.fn(),
}))
vi.mock('./account-providers/register', () => ({
  registerAllAccountProviders: vi.fn(),
}))
vi.mock('./analytics/server-analytics', () => ({
  setServerAnalyticsVersion: vi.fn(),
}))
vi.mock('./error-reporting', () => ({
  captureException: vi.fn(),
  initErrorReporting: vi.fn(),
  setErrorReportingUser: vi.fn(),
}))
vi.mock('./config/version', () => ({ APP_VERSION: '0.0.0-test' }))
const markBoot = vi.fn()
const logBootTiming = vi.fn()
vi.mock('./boot-timing', () => ({
  markBoot: (...args: unknown[]) => markBoot(...args),
  logBootTiming: () => logBootTiming(),
}))
vi.mock('../../main/host-browser', () => ({
  getActiveProvider: () => null,
  stopAllProviders: async () => { released.push('browser-providers') },
}))
const staleUploads = vi.hoisted(() => ({ startStaleUploadCleanup: vi.fn(), stopStaleUploadCleanup: vi.fn() }))
vi.mock('./utils/chunked-upload', () => staleUploads)
vi.mock('../../main/host-browser/profile-maintenance', () => ({
  startBrowserProfileCleanup: vi.fn(),
  stopBrowserProfileCleanup: () => { released.push('browser-profile-cleanup') },
}))
vi.mock('../../api/credentials/credential-broker', () => ({
  credentialBroker: { shutdown: async () => { released.push('credential-broker') } },
}))
vi.mock('../../main/browser-stream-proxy', () => ({ setupBrowserStreamProxy: vi.fn() }))
vi.mock('../../main/cloud-stream-proxy', () => ({ setupCloudStreamProxy: vi.fn() }))
vi.mock('./proxy/review-manager', () => ({ reviewManager: { rejectAll: vi.fn() } }))
vi.mock('./proxy/account-reauth-manager', () => ({ accountReauthManager: { rejectAll: vi.fn() } }))
vi.mock('./proxy/mcp-reauth-manager', () => ({ mcpReauthManager: { rejectAll: vi.fn() } }))
vi.mock('./scheduler/task-scheduler', () => ({
  taskScheduler: { id: 'task-scheduler', phase: 'background', startupIo: true, start: () => taskSchedulerStart(), stop: () => { released.push('task-scheduler') } },
}))
vi.mock('./scheduler/trigger-manager', () => ({
  triggerManager: { id: 'webhook-triggers', phase: 'background', startupIo: true, start: () => triggerManagerStart(), stop: () => { released.push('trigger-manager') } },
}))
vi.mock('./scheduler/platform-notifications-manager', () => ({
  platformNotificationsManager: { id: 'platform-notifications', phase: 'background', startupIo: true, start: () => platformNotificationsStart(), stop: () => { released.push('platform-notifications') } },
}))
vi.mock('./agent-integrations/agent-integration-manager', () => ({
  agentIntegrationManager: { id: 'agent-integrations', phase: 'background', startupIo: true, start: () => chatIntegrationStart(), stop: () => { released.push('agent-integrations') } },
}))
vi.mock('./scheduler/session-auto-delete-monitor', () => ({
  sessionAutoDeleteMonitor: { id: 'session-auto-delete', phase: 'background', start: () => Promise.resolve(), stop: () => { released.push('session-auto-delete') } },
}))
vi.mock('./scheduler/api-log-auto-delete-monitor', () => ({
  apiLogAutoDeleteMonitor: { id: 'api-log-auto-delete', phase: 'background', start: () => Promise.resolve(), stop: () => { released.push('api-log-auto-delete') } },
}))
vi.mock('./scheduler/account-sync-service', () => ({
  accountSyncService: { id: 'account-sync', phase: 'background', start: () => Promise.resolve(), stop: () => { released.push('account-sync') } },
}))
vi.mock('./services/platform-service', () => ({
  platformService: { id: 'platform', phase: 'background', start: vi.fn(), stop: () => { released.push('platform') } },
}))
vi.mock('./container/client-factory', () => ({
  shutdownActiveRunner: async () => { released.push('active-runner') },
}))
vi.mock('./computer-use/executor', () => ({
  shutdownAC: async () => { released.push('computer-use') },
}))

describe('initializeServices post-bind critical path', () => {
  beforeEach(async () => {
    vi.resetModules()
    reconcile.mockReset()
    validateAuth.mockReset().mockResolvedValue(undefined)
    listAgents.mockReset().mockResolvedValue([])
    initializeAgents.mockReset().mockResolvedValue(undefined)
    watchWebhookRelay.mockReset().mockReturnValue(() => {})
    relayState.started = false
    released.length = 0
    ensureImageReady.mockReset().mockResolvedValue(undefined)
    taskSchedulerStart.mockReset().mockResolvedValue(undefined)
    triggerManagerStart.mockReset().mockResolvedValue(undefined)
    platformNotificationsStart.mockReset().mockResolvedValue(undefined)
    chatIntegrationStart.mockReset().mockResolvedValue(undefined)
    getSettings.mockReset().mockReturnValue({})
    getPlatformAccessToken.mockReturnValue(null)
    clearPendingApprovalBans.mockClear()
    markBoot.mockClear()
    logBootTiming.mockClear()
    isAuthMode.mockReturnValue(true)
    // As an entry point does before it serves. The shared test setup installed the backend.
    const { registerBackgroundWork } = await import('./startup')
    registerBackgroundWork()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('runs skillset reconcile and auth validation before agent init', async () => {
    const order: string[] = []
    reconcile.mockImplementation(() => {
      order.push('reconcile')
    })
    validateAuth.mockImplementation(async () => {
      order.push('validateAuth')
    })
    listAgents.mockImplementation(async () => {
      order.push('listAgents')
      return []
    })

    const { initializeServices } = await import('./startup')
    await initializeServices()

    expect(order).toEqual(['reconcile', 'validateAuth', 'listAgents'])
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(validateAuth).toHaveBeenCalledTimes(1)
    expect(markBoot).toHaveBeenCalledWith('dbReady')
  })

  // A container started before the relay would be built with webhooks off.
  it('starts the webhook relay before agent init, then watches it once the agents are known', async () => {
    const order: string[] = []
    const { getWebhookRelay } = await import('./webhook-relay')
    watchWebhookRelay.mockImplementation(() => {
      order.push('watch')
      return () => {}
    })
    initializeAgents.mockImplementation(async () => {
      order.push(`initializeAgents:${getWebhookRelay().snapshot().unavailableReason ?? 'started'}`)
    })

    const { initializeServices } = await import('./startup')
    await initializeServices()

    expect(order).toEqual(['initializeAgents:started', 'watch'])
  })

  it('overlaps auth validation with agent discovery, then gates container init on both', async () => {
    let finishAuth: (() => void) | undefined
    let finishAgentList: ((agents: never[]) => void) | undefined
    validateAuth.mockImplementation(() => new Promise<void>((resolve) => { finishAuth = resolve }))
    listAgents.mockImplementation(() => new Promise<never[]>((resolve) => { finishAgentList = resolve }))

    const { initializeServices } = await import('./startup')
    const initializing = initializeServices()

    await vi.waitFor(() => {
      expect(validateAuth).toHaveBeenCalledTimes(1)
      expect(listAgents).toHaveBeenCalledTimes(1)
    })
    expect(initializeAgents).not.toHaveBeenCalled()

    finishAgentList?.([])
    await Promise.resolve()
    expect(initializeAgents).not.toHaveBeenCalled()

    finishAuth?.()
    await initializing
    expect(initializeAgents).toHaveBeenCalledWith([])
    expect(clearPendingApprovalBans).toHaveBeenCalledTimes(1)
  })


  it('starts the trigger manager without a platform token, so a later connect can deliver', async () => {
    const { initializeServices } = await import('./startup')
    await initializeServices()
    await vi.waitFor(() => expect(triggerManagerStart).toHaveBeenCalledTimes(1))
  })

  it('bounds heavy startup I/O to three concurrent tasks', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const controlledStart = () => new Promise<void>((resolve) => {
      active++
      peak = Math.max(peak, active)
      releases.push(() => {
        active--
        resolve()
      })
    })
    const starts = [
      ensureImageReady,
      taskSchedulerStart,
      triggerManagerStart,
      platformNotificationsStart,
      chatIntegrationStart,
    ]
    starts.forEach((start) => start.mockImplementation(controlledStart))
    const totalStarts = () => starts.reduce((sum, start) => sum + start.mock.calls.length, 0)

    const { initializeServices } = await import('./startup')
    await initializeServices()
    await vi.waitFor(() => expect(totalStarts()).toBe(3))
    expect(active).toBe(3)

    // The user-facing connects (notifications, chat) must be in the first
    // wave — they are cheap handshakes and must not queue behind the
    // open-ended catch-up work (image pull, overdue tasks, webhook events).
    expect(platformNotificationsStart).toHaveBeenCalledTimes(1)
    expect(chatIntegrationStart).toHaveBeenCalledTimes(1)

    while (totalStarts() < starts.length) {
      const previous = totalStarts()
      releases.shift()?.()
      await vi.waitFor(() => expect(totalStarts()).toBe(previous + 1))
      expect(active).toBe(3)
    }

    for (const release of releases.splice(0)) release()
    await vi.waitFor(() => expect(active).toBe(0))
    expect(peak).toBe(3)
  })

  it('is idempotent across concurrent callers', async () => {
    const { initializeServices } = await import('./startup')
    await Promise.all([initializeServices(), initializeServices()])
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(validateAuth).toHaveBeenCalledTimes(1)
  })

  it('skips auth validation when not in auth mode', async () => {
    isAuthMode.mockReturnValue(false)
    const { initializeServices } = await import('./startup')
    await initializeServices()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(validateAuth).not.toHaveBeenCalled()
    expect(ensureManagedPlatformConnection).toHaveBeenCalledTimes(1)
  })

  it('afterBindInitialize marks bound, inits, then logs timing', async () => {
    const { afterBindInitialize, getServicesInitError } = await import('./startup')
    await afterBindInitialize()
    expect(markBoot).toHaveBeenCalledWith('bound')
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(logBootTiming).toHaveBeenCalledTimes(1)
    expect(getServicesInitError()).toBeNull()
    expect(staleUploads.startStaleUploadCleanup).toHaveBeenCalledOnce()
  })

  it('leaves the stale-upload sweep to afterBindInitialize, not to importing this module or initializing services', async () => {
    const { initializeServices } = await import('./startup')
    await initializeServices()
    expect(staleUploads.startStaleUploadCleanup).not.toHaveBeenCalled()
  })

  it('starts the stale-upload sweep even when an auth gate fails init', async () => {
    validateAuth.mockRejectedValueOnce(new Error('platform unreachable'))
    const { afterBindInitialize } = await import('./startup')
    await afterBindInitialize()
    expect(initializeAgents).not.toHaveBeenCalled()
    expect(staleUploads.startStaleUploadCleanup).toHaveBeenCalledOnce()
  })

  it('stops the stale-upload sweep on shutdown', async () => {
    const { shutdownServices } = await import('./startup')
    // The rest of shutdown reaches services this file does not fake in full.
    await shutdownServices().catch(() => undefined)
    expect(staleUploads.stopStaleUploadCleanup).toHaveBeenCalledOnce()
  })

  describe('the service catalog', () => {
    // Dispatch has stopped before any of this. Services stop last registered
    // first, so what others use goes after them: browsers before the containers
    // they talk to, the relay before the long container stop, the agents after
    // their containers, and the runner after the agents.
    const SHUTDOWN_ORDER = [
      'browser-profile-cleanup',
      'platform',
      'account-sync',
      'api-log-auto-delete',
      'session-auto-delete',
      'trigger-manager',
      'task-scheduler',
      'agent-integrations',
      'platform-notifications',
      'credential-broker',
      'browser-providers',
      'relay-watcher',
      'status-sync',
      'health-monitor',
      'webhook-relay',
      'containers',
      'agents',
      'active-runner',
      'computer-use',
    ]

    /** Records the two releases startup's own mocks cannot see. */
    async function recordAgentsAndWatcher() {
      const { agentRegistry } = await import('./agent-actor')
      vi.spyOn(agentRegistry, 'evictAll').mockImplementation(async () => { released.push('agents') })
      watchWebhookRelay.mockReturnValue(() => { released.push('relay-watcher') })
    }

    it('registers every service and starts nothing, however often it is repeated', async () => {
      const { registerBackgroundWork } = await import('./startup')
      const { serviceHost, taskManager } = await import('./background-work')
      registerBackgroundWork()
      registerBackgroundWork()

      expect(Object.keys(serviceHost().states())).toEqual([
        'computer-use', 'active-runner', 'agent-registry', 'containers',
        'webhook-relay', 'container-host', 'ollama-catalog', 'host-browser',
        'platform-notifications', 'agent-integrations', 'container-image', 'task-scheduler', 'webhook-triggers',
        'session-auto-delete', 'api-log-auto-delete', 'account-sync', 'team-directory-provisioning', 'platform',
      ])
      expect(new Set(Object.values(serviceHost().states()))).toEqual(new Set(['registered']))
      expect((taskManager() as import('./background-work/local-task-manager').LocalTaskManager).scheduled()).toEqual([])
      expect(relayState.started).toBe(false)
      expect(initializeAgents).not.toHaveBeenCalled()
      expect(ensureImageReady).not.toHaveBeenCalled()
      expect(listAgents).not.toHaveBeenCalled()
    })

    it('shuts down in dependency order', async () => {
      const { initializeServices, shutdownServices } = await import('./startup')
      await recordAgentsAndWatcher()
      await initializeServices()
      await vi.waitFor(() => expect(triggerManagerStart).toHaveBeenCalledTimes(1))
      await shutdownServices()
      expect(released).toEqual(SHUTDOWN_ORDER)
    })

    it('has stopped dispatch before it releases anything', async () => {
      const { initializeServices, shutdownServices } = await import('./startup')
      const { taskManager } = await import('./background-work')
      await initializeServices()
      const stop = vi.spyOn(taskManager(), 'stop').mockImplementation(async () => { released.push('dispatch') })
      await shutdownServices()
      expect(released.slice(0, 2)).toEqual(['browser-profile-cleanup', 'dispatch'])
      stop.mockRestore()
    })

    it('releases everything even when initialization failed partway', async () => {
      validateAuth.mockRejectedValueOnce(new Error('platform unreachable'))
      const { afterBindInitialize, shutdownServices } = await import('./startup')
      await recordAgentsAndWatcher()
      await afterBindInitialize({ degradedOnFailure: true })
      await shutdownServices()
      // The relay watcher never started: nothing to stop there.
      expect(released).toEqual(SHUTDOWN_ORDER.filter(name => name !== 'relay-watcher'))
    })

    it('leaves the rest unstarted when the container host fails to initialize', async () => {
      initializeAgents.mockRejectedValueOnce(new Error('runtime down'))
      const { afterBindInitialize, getServicesInitError } = await import('./startup')
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await afterBindInitialize({ degradedOnFailure: true })
      expect(getServicesInitError()).toBe('runtime down')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(watchWebhookRelay).not.toHaveBeenCalled()
      expect(chatIntegrationStart).not.toHaveBeenCalled()
      expect(taskSchedulerStart).not.toHaveBeenCalled()
      error.mockRestore()
    })

    it('keeps other services running when one background service fails to start', async () => {
      chatIntegrationStart.mockRejectedValueOnce(new Error('no integrations'))
      const { initializeServices } = await import('./startup')
      const { serviceHost } = await import('./background-work')
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await initializeServices()
      await vi.waitFor(() => expect(serviceHost().states()['webhook-triggers']).toBe('started'))
      expect(serviceHost().states()['agent-integrations']).toBe('failed')
      error.mockRestore()
    })

    it('starts nothing still queued once shutdown begins, and stops again what was in flight', async () => {
      const holds: Array<() => void> = []
      const hold = () => new Promise<void>((resolve) => { holds.push(resolve) })
      platformNotificationsStart.mockImplementation(hold)
      chatIntegrationStart.mockImplementation(hold)
      ensureImageReady.mockImplementation(hold)
      const { initializeServices, shutdownServices } = await import('./startup')
      await initializeServices()
      await vi.waitFor(() => expect(holds).toHaveLength(3))

      await shutdownServices()
      released.length = 0
      holds.forEach(resolve => resolve())
      await vi.waitFor(() => expect(released).toEqual(expect.arrayContaining(['platform-notifications', 'agent-integrations'])))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(taskSchedulerStart).not.toHaveBeenCalled()
      expect(triggerManagerStart).not.toHaveBeenCalled()
    })

    it('picks no backend: registering before an entry point installs one throws', async () => {
      const { closeBackgroundWork } = await import('./background-work')
      await closeBackgroundWork()
      const { registerBackgroundWork } = await import('./startup')
      expect(() => registerBackgroundWork()).toThrow('Background work is not initialized')
    })

    it('stays shut down when it comes before the entry point installed background work', async () => {
      const { closeBackgroundWork, initializeBackgroundWork } = await import('./background-work')
      const { LocalTaskManager } = await import('./background-work/local-task-manager')
      await closeBackgroundWork()
      released.length = 0
      const { afterBindInitialize, registerBackgroundWork, shutdownServices } = await import('./startup')
      await shutdownServices()
      // Nothing has started, so no service has anything to let go of.
      expect(released).toEqual(['browser-profile-cleanup'])

      // The entry point was still on its way there, and carries on.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await initializeBackgroundWork(new LocalTaskManager())
      registerBackgroundWork()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the host has stopped'))
      warn.mockRestore()
      await afterBindInitialize({ degradedOnFailure: true })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(relayState.started).toBe(false)
      expect(initializeAgents).not.toHaveBeenCalled()
      expect(ensureImageReady).not.toHaveBeenCalled()
      expect(taskSchedulerStart).not.toHaveBeenCalled()
    })
  })

  it('records the init error for runtime-status when init fails degraded', async () => {
    validateAuth.mockRejectedValueOnce(new Error('platform unreachable'))
    const { afterBindInitialize, getServicesInitError } = await import('./startup')
    await afterBindInitialize({ degradedOnFailure: true })
    expect(getServicesInitError()).toBe('platform unreachable')
    expect(initializeAgents).not.toHaveBeenCalled()
    expect(logBootTiming).toHaveBeenCalledTimes(1)
  })
})
