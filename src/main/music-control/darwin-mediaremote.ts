import fs from 'fs'
import path from 'path'
import type { NowPlayingPlayer } from '@shared/lib/voice/now-playing-types'
import { mediaRemoteNowPlayingSchema } from './mediaremote-schema'
import { runCommand, type NowPlayingBackend, type RunCommand } from './backend'

/**
 * Apple's own perl is entitled to use the private MediaRemote framework,
 * which no third-party process has been since macOS 15.4. The adapter is a
 * perl script plus a small framework it loads; both are built by
 * scripts/build-mediaremote-adapter.sh and shipped as extra resources.
 */
export const PERL = '/usr/bin/perl'
export const ADAPTER_SCRIPT = 'mediaremote-adapter.pl'
export const ADAPTER_FRAMEWORK = 'MediaRemoteAdapter.framework'

/** MediaRemote command ids the adapter's `send` takes. */
const MR_PLAY = '0'
const MR_PAUSE = '1'

/** Bundle ids people would not recognise by their last segment. */
const KNOWN_NAMES: Record<string, string> = {
  'com.spotify.client': 'Spotify',
  'com.apple.Music': 'Music',
  'com.apple.iTunes': 'iTunes',
  'com.apple.Safari': 'Safari',
  'com.google.Chrome': 'Chrome',
  'com.brave.Browser': 'Brave',
  'com.microsoft.edgemac': 'Edge',
  'company.thebrowser.Browser': 'Arc',
  'org.mozilla.firefox': 'Firefox',
  'com.tidal.desktop': 'TIDAL',
  'com.apple.podcasts': 'Podcasts',
  'tv.plex.plexamp': 'Plexamp',
  'com.apple.TV': 'TV',
}

/** "Spotify" from "com.spotify.client", or the last segment when the id is not a known one. */
export function playerNameFromBundleId(bundleId: string): string {
  const known = KNOWN_NAMES[bundleId]
  if (known) return known
  const last = bundleId.split('.').filter(Boolean).at(-1) ?? bundleId
  return last.charAt(0).toUpperCase() + last.slice(1)
}

export interface MediaRemoteAdapterPaths {
  script: string
  framework: string
}

/** Where the built adapter lives; null when it was never built (a dev checkout without the build step). */
export function findMediaRemoteAdapter(dir: string): MediaRemoteAdapterPaths | null {
  const script = path.join(dir, ADAPTER_SCRIPT)
  const framework = path.join(dir, ADAPTER_FRAMEWORK)
  if (!fs.existsSync(script) || !fs.existsSync(framework)) return null
  return { script, framework }
}

export class DarwinMediaRemoteBackend implements NowPlayingBackend {
  constructor(
    private readonly adapter: MediaRemoteAdapterPaths,
    private readonly run: RunCommand = runCommand,
  ) {}

  async probe(): Promise<NowPlayingPlayer | null> {
    const stdout = await this.run(PERL, [this.adapter.script, this.adapter.framework, 'get', '--no-artwork'])
    const trimmed = stdout.trim()
    if (!trimmed) return null
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      throw new Error(`MediaRemote adapter printed something other than JSON: ${trimmed.slice(0, 200)}`)
    }
    const info = mediaRemoteNowPlayingSchema.parse(raw)
    if (!info?.playing) return null
    // A browser reports through a helper process; the parent is the app the person knows.
    const id = info.parentApplicationBundleIdentifier ?? info.bundleIdentifier
    return { id, name: playerNameFromBundleId(id) }
  }

  // MediaRemote commands go to whichever app holds now playing; there is no
  // per-player addressing, so the player id is only a record of intent.
  async pause(_playerId: string): Promise<void> {
    await this.run(PERL, [this.adapter.script, this.adapter.framework, 'send', MR_PAUSE])
  }

  async play(_playerId: string): Promise<void> {
    await this.run(PERL, [this.adapter.script, this.adapter.framework, 'send', MR_PLAY])
  }
}
