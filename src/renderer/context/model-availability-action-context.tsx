import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react'

import { openExternalUrl } from '@renderer/lib/open-external'
import { lazyWithReload } from '@renderer/lib/lazy-with-reload'
import type { ModelAvailabilityAction } from '@shared/lib/llm-provider/model-availability-schema'
import { PLATFORM_PLAN_UPGRADE_ACTION } from '@shared/lib/llm-provider/platform-plan-policy'

export interface ModelAvailabilityActionRequest {
  /** The provider's action, from its availability (or its own surfaces). */
  action: ModelAvailabilityAction
  /** The model that prompted it (a locked pick or a refusal); none = the flow on its own. */
  model?: { id: string; label: string }
  /** Connection that supplied the restriction, for a fresh availability check. */
  connectionId?: string
}

export interface ModelAvailabilityActionProps {
  request: ModelAvailabilityActionRequest
  onClose: () => void
}

type OpenAction = (request: ModelAvailabilityActionRequest) => void

// `availability.action.component` → the dialog that resolves it. Adding a provider's flow = one row here.
const REGISTRY: Record<string, LazyExoticComponent<ComponentType<ModelAvailabilityActionProps>>> = {
  [PLATFORM_PLAN_UPGRADE_ACTION]: lazyWithReload(() =>
    import('@renderer/components/billing/plan-upgrade-dialog').then((m) => ({ default: m.PlanUpgradeDialog })),
  ),
}

// Without a dialog for it (an unknown key, or a host without the provider), send
// the user to the provider's page for it, if it named one.
function openActionHref({ action }: ModelAvailabilityActionRequest): void {
  if (action.href) void openExternalUrl(action.href)
}

const ModelAvailabilityActionContext = createContext<OpenAction | null>(null)

/**
 * Owns the one dialog a provider's availability action opens, so a locked
 * model in any picker, a refusal card and a provider's own screens all run the
 * same flow.
 */
export function ModelAvailabilityActionProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ModelAvailabilityActionRequest | null>(null)
  const open = useCallback<OpenAction>((next) => {
    if (REGISTRY[next.action.component]) setRequest(next)
    else openActionHref(next)
  }, [])
  const Dialog = request ? REGISTRY[request.action.component] : undefined
  return (
    <ModelAvailabilityActionContext.Provider value={open}>
      {children}
      {request && Dialog && (
        <Suspense fallback={null}>
          <Dialog request={request} onClose={() => setRequest(null)} />
        </Suspense>
      )}
    </ModelAvailabilityActionContext.Provider>
  )
}

/**
 * Runs a provider's availability action. Hosts without the provider (the
 * standalone quick-dispatch window) open the action's page in the browser.
 */
export function useModelAvailabilityAction(): OpenAction {
  return useContext(ModelAvailabilityActionContext) ?? openActionHref
}
