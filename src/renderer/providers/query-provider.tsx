
import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createAppQueryClient } from '@renderer/lib/query-client'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // Query defaults + global error handling (Sentry reporting + default mutation
  // error toast) live in createAppQueryClient — see src/renderer/lib/query-client.ts.
  const [queryClient] = useState(createAppQueryClient)

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
