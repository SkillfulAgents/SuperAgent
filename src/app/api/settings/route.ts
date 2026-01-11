import { NextRequest, NextResponse } from 'next/server'
import { getDataDir } from '@/lib/config/data-dir'
import {
  getSettings,
  updateSettings,
  getAnthropicApiKeyStatus,
  type AppSettings,
  type ContainerSettings,
  type ApiKeyStatus,
} from '@/lib/config/settings'
import { containerManager } from '@/lib/container/container-manager'
import { checkAllRunnersAvailability, type RunnerAvailability } from '@/lib/container/client-factory'

export interface GlobalSettingsResponse {
  dataDir: string
  container: ContainerSettings
  hasRunningAgents: boolean
  runnerAvailability: RunnerAvailability[]
  apiKeyStatus: {
    anthropic: ApiKeyStatus
  }
}

// GET /api/settings - Get global settings
export async function GET() {
  try {
    const settings = getSettings()
    const [hasRunningAgents, runnerAvailability] = await Promise.all([
      containerManager.hasRunningAgents(),
      checkAllRunnersAvailability(),
    ])

    const response: GlobalSettingsResponse = {
      dataDir: getDataDir(),
      container: settings.container,
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
      },
    }

    return NextResponse.json(response)
  } catch (error: any) {
    console.error('Failed to fetch settings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 }
    )
  }
}

// PUT /api/settings - Update settings
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const currentSettings = getSettings()
    const hasRunningAgents = await containerManager.hasRunningAgents()

    // Check if trying to change restricted settings while agents are running
    if (hasRunningAgents && body.container) {
      const newContainer = body.container as Partial<ContainerSettings>

      // Block changes to containerRunner or resourceLimits if agents are running
      if (
        (newContainer.containerRunner !== undefined &&
         newContainer.containerRunner !== currentSettings.container.containerRunner) ||
        (newContainer.resourceLimits !== undefined &&
         JSON.stringify(newContainer.resourceLimits) !== JSON.stringify(currentSettings.container.resourceLimits))
      ) {
        return NextResponse.json(
          {
            error: 'Cannot change container runner or resource limits while agents are running. Please stop all agents first.',
            runningAgents: await containerManager.getRunningAgentIds()
          },
          { status: 409 }
        )
      }
    }

    // Merge new settings with current settings
    const newSettings: AppSettings = {
      container: {
        ...currentSettings.container,
        ...body.container,
        resourceLimits: body.container?.resourceLimits
          ? { ...currentSettings.container.resourceLimits, ...body.container.resourceLimits }
          : currentSettings.container.resourceLimits,
      },
      apiKeys: currentSettings.apiKeys,
    }

    // Handle API key updates
    if (body.apiKeys !== undefined) {
      if (body.apiKeys.anthropicApiKey === '') {
        // Empty string means delete the saved key
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.anthropicApiKey
        // Clean up empty object
        if (Object.keys(newSettings.apiKeys).length === 0) {
          delete newSettings.apiKeys
        }
      } else if (body.apiKeys.anthropicApiKey) {
        // Save the new key
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          anthropicApiKey: body.apiKeys.anthropicApiKey,
        }
      }
    }

    updateSettings(newSettings)

    const runnerAvailability = await checkAllRunnersAvailability()

    return NextResponse.json({
      dataDir: getDataDir(),
      container: newSettings.container,
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
      },
    })
  } catch (error: any) {
    console.error('Failed to update settings:', error)
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    )
  }
}
