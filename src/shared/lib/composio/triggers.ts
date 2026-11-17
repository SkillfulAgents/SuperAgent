/**
 * Composio Trigger Client
 *
 * Calls the platform proxy's trigger management endpoints.
 * Only works when platform Composio is active (not local API key mode).
 */

import { composioFetch } from './client'

// ============================================================================
// Available Trigger Types
// ============================================================================

export interface AvailableTrigger {
  slug: string
  name: string
  description: string
  type: 'webhook' | 'poll'
  config?: unknown
  payload?: unknown
}

interface TriggerTypesResponse {
  items: Array<{
    slug: string
    name: string
    description: string
    type: string
    config?: unknown
    payload?: unknown
  }>
}

export async function getAvailableTriggers(toolkitSlug: string): Promise<AvailableTrigger[]> {
  const params = new URLSearchParams({ toolkit_slug: toolkitSlug })
  const response = await composioFetch<TriggerTypesResponse>(`/triggers/types?${params}`)
  return (response.items || []).map((item) => ({
    slug: item.slug,
    name: item.name,
    description: item.description,
    type: item.type as 'webhook' | 'poll',
    config: item.config,
    payload: item.payload,
  }))
}

// ============================================================================
// Trigger Instance Management
// ============================================================================

interface EnableTriggerResponse {
  trigger_id: string
}

export async function enableComposioTrigger(
  triggerSlug: string,
  connectedAccountId: string,
  triggerConfig?: Record<string, unknown>,
): Promise<string> {
  const body: Record<string, unknown> = { connected_account_id: connectedAccountId }
  if (triggerConfig) {
    body.trigger_config = triggerConfig
  }

  const response = await composioFetch<EnableTriggerResponse>(
    `/triggers/${encodeURIComponent(triggerSlug)}/enable`,
    { method: 'POST', body: JSON.stringify(body) },
  )

  return response.trigger_id
}

export async function disableComposioTrigger(composioTriggerId: string): Promise<void> {
  await composioFetch(
    `/triggers/${encodeURIComponent(composioTriggerId)}/disable`,
    { method: 'PATCH' },
  )
}

export async function deleteComposioTrigger(composioTriggerId: string): Promise<void> {
  await composioFetch(
    `/triggers/${encodeURIComponent(composioTriggerId)}`,
    { method: 'DELETE' },
  )
}

// ============================================================================
// List Active Triggers
// ============================================================================

interface ActiveTriggersResponse {
  items: Array<{
    id: string
    trigger_name: string
    connected_account_id: string
    trigger_config?: unknown
    disabled_at?: string | null
  }>
}

export interface ActiveComposioTrigger {
  id: string
  triggerName: string
  connectedAccountId: string
  triggerConfig?: unknown
  isDisabled: boolean
}

export async function listActiveComposioTriggers(): Promise<ActiveComposioTrigger[]> {
  const response = await composioFetch<ActiveTriggersResponse>('/triggers/active')
  return (response.items || []).map((item) => ({
    id: item.id,
    triggerName: item.trigger_name,
    connectedAccountId: item.connected_account_id,
    triggerConfig: item.trigger_config,
    isDisabled: Boolean(item.disabled_at),
  }))
}

