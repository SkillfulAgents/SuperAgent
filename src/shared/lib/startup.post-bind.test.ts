import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.fn()
const validateAuth = vi.fn().mockResolvedValue(undefined)
const listAgents = vi.fn().mockResolvedValue([])
const initializeAgents = vi.fn().mockResolvedValue(undefined)
const getSettings = vi.fn().mockReturnValue({})
const getPlatformAccessToken = vi.fn().mockReturnValue(null)
const isAuthMode = vi.fn().mockReturnValue(true)

vi.mock('./services/skillset-reconcile', () => ({
  reconcileSkillsetConfigsForCurrentAuth: () => reconcile(),
}))
vi.mock('./auth/startup-validation', () => ({
  validateAuthModeStartup: () => validateAuth(),
}))
vi.mock('./auth/mode', () => ({
  isAuthMode: () => isAuthMode(),
}))
vi.mock('./services/agent-service', () => ({
  listAgents: () => listAgents(),
}))
vi.mock('./container/container-manager', () => ({
  containerManager: {
    initializeAgents: (...args: unknown[]) => initializeAgents(...args),
    ensureImageReady: () => Promise.resolve(),
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
vi.mock('./boot-timing', () => ({ markBoot: vi.fn() }))
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
  taskScheduler: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./scheduler/trigger-manager', () => ({
  triggerManager: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./scheduler/platform-notifications-manager', () => ({
  platformNotificationsManager: { start: () => Promise.resolve(), stop: vi.fn() },
}))
vi.mock('./chat-integrations/chat-integration-manager', () => ({
  chatIntegrationManager: { start: () => Promise.resolve(), stop: vi.fn() },
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
    reconcile.mockClear()
    validateAuth.mockClear()
    listAgents.mockClear()
    initializeAgents.mockClear()
    getSettings.mockClear()
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
})
