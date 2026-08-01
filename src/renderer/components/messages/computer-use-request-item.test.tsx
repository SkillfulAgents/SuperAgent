// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

vi.mock('./request-item-shell', () => ({
  // `title` is a prop, not a child, and it carries the prompt the permission
  // wording tests below read. A mock that renders only children would drop it
  // and pass them for the wrong reason.
  RequestItemShell: ({ title, children }: { title?: string; children: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      {children}
    </div>
  ),
}))
vi.mock('./request-item-actions', () => ({
  RequestItemActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('./decline-button', () => ({ DeclineButton: () => null }))
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { ComputerUseRequestItem } from './computer-use-request-item'

const PROPS = {
  toolUseId: 't1',
  method: 'click',
  params: {},
  permissionLevel: 'use_application',
  sessionId: 's1',
  agentSlug: 'sales',
  onComplete: vi.fn(),
}

function drive(target: 'local' | 'cloud') {
  _resetApiTargetForTest() // the global setup already settled it to 'local'
  setActiveTarget(target, null)
}

/** Approve once, so the API can answer with the missing-permission payload. */
async function triggerPermissionPrompt() {
  await userEvent.click(screen.getByRole('button', { name: /allow/i }))
  await waitFor(() => expect(screen.getByText('Accessibility')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  window.electronAPI = { platform: 'darwin', openExternal: vi.fn() } as never
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ missingPermissions: { accessibility: false, screen_recording: false } }),
  })
  drive('local')
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
  _resetApiTargetForTest()
})

/**
 * The permission is needed on the machine that runs the agent; the deep link
 * opens System Settings on this one. Same machine locally — but against a cloud
 * workspace it sends you to grant Accessibility on a laptop nobody is
 * automating, and the request stays stuck either way.
 */
describe('missing computer-use permissions', () => {
  it('offers to open System Settings when this computer is the one being automated', async () => {
    render(<ComputerUseRequestItem {...PROPS} />)
    await triggerPermissionPrompt()

    expect(screen.getAllByRole('button', { name: /open settings/i }).length).toBeGreaterThan(0)
  })

  it('does not send you to fix the wrong computer against a cloud workspace', async () => {
    drive('cloud')
    render(<ComputerUseRequestItem {...PROPS} />)
    await triggerPermissionPrompt()

    expect(screen.queryByRole('button', { name: /open settings/i })).not.toBeInTheDocument()
  })

  it('still names the permissions remotely — that part is true and worth relaying', async () => {
    drive('cloud')
    render(<ComputerUseRequestItem {...PROPS} />)
    await triggerPermissionPrompt()

    expect(screen.getByText('Accessibility')).toBeInTheDocument()
    expect(screen.getByText('Screen Recording')).toBeInTheDocument()
  })
})

describe('ComputerUseRequestItem permission labels', () => {
  it('explains read-only access in both the prompt and permission badge', () => {
    render(<ComputerUseRequestItem {...PROPS} method="apps" permissionLevel="list_apps_windows" />)

    expect(
      screen.getByText('Allow the agent to list apps & windows (read-only)?'),
    ).toBeInTheDocument()
    expect(screen.getByText('List Apps & Windows (read-only)')).toBeInTheDocument()
  })

  it('uses the self-explanatory shell permission wording', () => {
    render(<ComputerUseRequestItem {...PROPS} method="run" permissionLevel="use_host_shell" />)

    expect(screen.getByText('Allow the agent to run shell commands & scripts?')).toBeInTheDocument()
    expect(screen.getByText('Run Shell Commands & Scripts')).toBeInTheDocument()
    expect(screen.queryByText('Host Shell')).not.toBeInTheDocument()
  })
})
