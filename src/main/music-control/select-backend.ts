import type { NowPlayingBackend } from './backend'
import { DarwinMediaRemoteBackend, findMediaRemoteAdapter } from './darwin-mediaremote'
import { LinuxMprisBackend } from './linux-mpris'

/**
 * The integration for this host, or null where there is none: Windows until
 * a Global System Media Transport Controls helper ships, and a macOS dev
 * checkout that has not run scripts/build-mediaremote-adapter.sh.
 */
export function selectNowPlayingBackend(platform: NodeJS.Platform, mediaRemoteAdapterDir: string): NowPlayingBackend | null {
  if (platform === 'darwin') {
    const adapter = findMediaRemoteAdapter(mediaRemoteAdapterDir)
    if (!adapter) {
      console.warn(`[music-control] MediaRemote adapter not found in ${mediaRemoteAdapterDir}; run "npm run build:mediaremote-adapter" to control the music player from voice mode`)
      return null
    }
    return new DarwinMediaRemoteBackend(adapter)
  }
  if (platform === 'linux') return new LinuxMprisBackend()
  return null
}
