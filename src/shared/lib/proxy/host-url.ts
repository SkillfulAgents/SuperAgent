import { getSettings } from '@shared/lib/config/settings'

export function getContainerHostUrl(): string {
  const settings = getSettings()
  const runner = settings.container.containerRunner

  if (runner === 'podman') {
    return 'host.containers.internal'
  }
  return 'host.docker.internal'
}

export function getAppPort(): number {
  return parseInt(process.env.PORT || '47891', 10)
}
