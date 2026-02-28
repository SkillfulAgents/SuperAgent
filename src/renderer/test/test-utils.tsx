import { render, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectivityProvider } from '@renderer/context/connectivity-context'
import type { ReactElement, ReactNode } from 'react'

export { screen, waitFor, within, act } from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  })
}

function AllProviders({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectivityProvider>
        {children}
      </ConnectivityProvider>
    </QueryClientProvider>
  )
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, { wrapper: AllProviders, ...options })
}
