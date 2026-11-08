/**
 * The directory providers this build knows. Built-ins are listed here; a test
 * registers its own fake through the same call, so it travels every path a
 * real provider does.
 */
import { slackDirectoryProvider } from './providers/slack'
import type { TeamDirectoryProvider } from './types'

const providers = new Map<string, TeamDirectoryProvider<any>>([
  [slackDirectoryProvider.info.id, slackDirectoryProvider],
])

export function registerDirectoryProvider(provider: TeamDirectoryProvider<any>): () => void {
  providers.set(provider.info.id, provider)
  return () => {
    if (providers.get(provider.info.id) === provider) providers.delete(provider.info.id)
  }
}

export function getDirectoryProvider(id: string): TeamDirectoryProvider<unknown> | undefined {
  return providers.get(id)
}

export function listDirectoryProviders(): TeamDirectoryProvider<unknown>[] {
  return [...providers.values()]
}
