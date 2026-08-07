import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.fn()
const validateAuth = vi.fn().mockResolvedValue(undefined)
const listAgents = vi.fn().mockResolvedValue([])
const initializeAgents = vi.fn().mockResolvedValue(undefined)
const ensureImageReady = vi.fn().mockResolvedValue(undefined)
const taskSchedulerStart = vi.fn().mockResolvedValue(undefined)
const triggerManagerStart = vi.fn().mockResolvedValue(undefined)
const platformNotificationsStart = vi.fn().mockResolvedValue(undefined)
const chatIntegrationStart = vi.fn().mockResolvedValue(undefined)
const getSettings = vi.fn().mockReturnValue({})
const getPlatformAccessToken = vi.fn().mockReturnValue(null)
const isAuthMode = vi.fn().mockReturnValue(true)
const clearPendingApprovalBans = vi.fn()

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
vi.mock('./services/agent-service', () => ({
  listAgents: () => listAgents(),
}))
vi.mock('./container/container-manager', () => ({
  containerManager: {
    initializeAgents: (...args: unknown[]) => initializeAgents(...args),
    ensureImageReady: () => ensureImageReady(),
    startStatusSync: vi.fn(),
    startHealthMonitor: vi.fn(),
    onBeforeContainerStop: null,
    stopStatusSync: vi.fn(),
    stopHealthMonitor: vi.fn(),
    stopAll: () => Promise.resolve(),
  },
}))
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
  stopAllProviders: () => Promise.resolve(),
}))
vi.mock('../../main/host-browser/profile-maintenance', () => ({
  startBrowserProfileCleanup: vi.fn(),
  stopBrowserProfileCleanup: vi.fn(),
}))
vi.mock('../../main/browser-stream-proxy', () => ({ setupBrowserStreamProxy: vi.fn() }))
vi.mock('../../main/cloud-stream-proxy', () => ({ setupCloudStreamProxy: vi.fn() }))
vi.mock('./proxy/review-manager', () => ({ reviewManager: { rejectAll: vi.fn() } }))
vi.mock('./scheduler/task-scheduler', () => ({
  taskScheduler: { start: () => taskSchedulerStart(), stop: vi.fn() },
}))
vi.mock('./scheduler/trigger-manager', () => ({
  triggerManager: { start: () => triggerManagerStart(), stop: vi.fn() },
}))
vi.mock('./scheduler/platform-notifications-manager', () => ({
  platformNotificationsManager: { start: () => platformNotificationsStart(), stop: vi.fn() },
}))
vi.mock('./chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: { start: () => chatIntegrationStart(), stop: vi.fn() },
}))
vi.mock('./scheduler/auto-sleep-monitor', () => ({
  autoSleepMonitor: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./scheduler/session-auto-delete-monitor', () => ({
  sessionAutoDeleteMonitor: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./scheduler/account-sync-service', () => ({
  accountSyncService: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./services/platform-service', () => ({
  platformService: { start: vi.fn(), stop: vi.fn() },
}))
vi.mock('./container/client-factory', () => ({
  shutdownActiveRunner: () => Promise.resolve(),
}))
vi.mock('./computer-use/executor', () => ({
  shutdownAC: () => Promise.resolve(),
}))

describe('initializeServices post-bind critical path', () => {
  beforeEach(() => {
    vi.resetModules()
    reconcile.mockReset()
    validateAuth.mockReset().mockResolvedValue(undefined)
    listAgents.mockReset().mockResolvedValue([])
    initializeAgents.mockReset().mockResolvedValue(undefined)
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

  it('bounds heavy startup I/O to three concurrent tasks', async () => {
    getPlatformAccessToken.mockReturnValue('profile-token')
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
  })

  it('afterBindInitialize marks bound, inits, then logs timing', async () => {
    const { afterBindInitialize, getServicesInitError } = await import('./startup')
    await afterBindInitialize()
    expect(markBoot).toHaveBeenCalledWith('bound')
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(logBootTiming).toHaveBeenCalledTimes(1)
    expect(getServicesInitError()).toBeNull()
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
