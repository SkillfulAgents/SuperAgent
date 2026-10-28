// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import {
  clearPendingSessionSeeds,
  peekPendingSessionSeed,
  seedPendingSessionMessage,
} from '@renderer/context/pending-session-seed'
import { AgentShell } from './agent-shell'

function SeedConsumer() {
  const { getPendingMessages } = usePendingMessages()
  return <div>{getPendingMessages('session-1')[0]?.text ?? 'missing'}</div>
}

vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <SeedConsumer />,
  useNavigate: () => vi.fn(),
  useParams: () => ({ slug: 'agent-1', sessionId: 'session-1' }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: null, isAuthMode: false, canUseAgent: () => true }),
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ contextUsage: null }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useStartAgent: () => vi.fn(),
  useStopAgent: () => vi.fn(),
}))

vi.mock('@renderer/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded' }),
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

vi.mock('@renderer/lib/env', () => ({
  getPlatform: () => 'linux',
  isElectron: () => false,
}))

vi.mock('@renderer/components/ui/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./content-shell', () => ({
  ContentShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./agent-header', () => ({ AgentHeader: () => null }))
vi.mock('./agent-banners', () => ({ AgentBanners: () => null }))

describe('AgentShell pending session seed', () => {
  beforeEach(() => {
    clearPendingSessionSeeds()
  })

  it('keeps the wizard seed through the StrictMode render retry and clears it after commit', async () => {
    seedPendingSessionMessage('session-1', 'Hello from wizard', 'message-1')

    render(
      <StrictMode>
        <AgentShell />
      </StrictMode>,
    )

    expect(screen.getByText('Hello from wizard')).toBeTruthy()
    await waitFor(() => expect(peekPendingSessionSeed('session-1')).toBeUndefined())
  })
})
