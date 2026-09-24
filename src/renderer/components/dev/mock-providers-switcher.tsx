import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  MOCK_PROVIDERS_EVENT, MOCK_PROVIDER_SCENARIOS, getMockScenario, readMockScenarioFromUrl, setMockScenario,
  type MockProviderScenario,
} from '@renderer/lib/dev/mock-providers'

declare global {
  interface Window {
    /** Dev only: `mockProviders('warning')` turns on mock provider connections; `mockProviders(null)` turns them off. */
    mockProviders?: (scenario: MockProviderScenario | null) => void
  }
}

/**
 * Dev-only floating switcher for the mock provider connections in
 * `lib/dev/mock-providers.ts`: a small "Mock providers" pill while off, the
 * scenario picker while on. Hidden in E2E mock builds.
 */
export function MockProvidersSwitcher() {
  const queryClient = useQueryClient()
  const [scenario, setScenario] = useState(getMockScenario)

  useEffect(() => {
    window.mockProviders = setMockScenario
    const onChange = () => {
      setScenario(getMockScenario())
      // Reset (not just invalidate) usage so the "slow" state shows its loading gap.
      void queryClient.resetQueries({ queryKey: ['llm-provider-usage'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
    window.addEventListener(MOCK_PROVIDERS_EVENT, onChange)
    readMockScenarioFromUrl()
    return () => {
      window.removeEventListener(MOCK_PROVIDERS_EVENT, onChange)
      delete window.mockProviders
    }
  }, [queryClient])

  // E2E runs and PR screenshots use dev builds too; keep them free of the pill.
  if (__E2E_MOCK__) return null
  const frame = 'fixed left-1/2 top-2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-md border border-dashed border-orange-500/60 bg-background/95 text-xs shadow-sm [-webkit-app-region:no-drag]'
  if (!scenario) {
    return (
      <button type="button" data-testid="mock-providers-on" onClick={() => setMockScenario('healthy')}
        className={`${frame} px-2 py-1 font-medium text-orange-600 opacity-60 hover:opacity-100 dark:text-orange-400`}>
        Mock providers
      </button>
    )
  }
  return (
    <div className={`${frame} px-2 py-1`}>
      <span className="font-medium text-orange-600 dark:text-orange-400">Mock providers</span>
      <select
        aria-label="Mock provider usage scenario"
        value={scenario}
        onChange={e => setMockScenario(e.target.value as MockProviderScenario)}
        className="rounded-sm border border-border bg-background px-1 py-0.5 text-xs"
      >
        {Object.entries(MOCK_PROVIDER_SCENARIOS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <button type="button" onClick={() => setMockScenario(null)} className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        Off
      </button>
    </div>
  )
}
