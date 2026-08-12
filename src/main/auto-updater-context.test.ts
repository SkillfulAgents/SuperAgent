import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.5.5', on: vi.fn(), isPackaged: true },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn() },
}))
vi.mock('@shared/lib/services/user-settings-service', () => ({ getUserSettings: () => ({}) }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { safeUpdaterFailureContext } from './auto-updater'

describe('safe updater failure context', () => {
  it('categorizes verification and HTTP failures without retaining sensitive text', () => {
    const signature = safeUpdaterFailureContext(new Error('Authenticode rejected C:\\Users\\alice\\secret.exe for CN=Alice'))
    const http = safeUpdaterFailureContext(Object.assign(new Error('HTTP 618 <html>token=secret</html>'), { statusCode: 618 }))

    expect(signature).toEqual({ category: 'signature' })
    expect(http).toEqual({ category: 'http' })
    expect(JSON.stringify([signature, http])).not.toContain('alice')
    expect(JSON.stringify([signature, http])).not.toContain('secret')
  })

  it('keeps only bounded machine codes and identifies disk-full noise', () => {
    expect(safeUpdaterFailureContext(Object.assign(new Error('/Users/alice/update.zip is full'), { code: 'ENOSPC' })))
      .toEqual({ category: 'disk-full', code: 'ENOSPC' })
    expect(safeUpdaterFailureContext(Object.assign(new Error('failed'), { code: 'secret/token?x=1' })))
      .toEqual({ category: 'unknown' })
  })
})
