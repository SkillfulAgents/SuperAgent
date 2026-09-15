import type { NowPlayingPlayer } from '@shared/lib/voice/now-playing-types'
import { runCommand, type NowPlayingBackend, type RunCommand } from './backend'

/**
 * Every desktop player on Linux, browsers included, registers on the session
 * bus under org.mpris.MediaPlayer2.*. dbus-send ships with D-Bus itself, so
 * the bus is asked through it rather than through a Node binding.
 */
export const DBUS_SEND = 'dbus-send'
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.'
const MPRIS_PATH = '/org/mpris/MediaPlayer2'
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player'
const ROOT_INTERFACE = 'org.mpris.MediaPlayer2'

/** Bus names listed by org.freedesktop.DBus.ListNames that belong to MPRIS players. */
export function parseMprisBusNames(listNamesOutput: string): string[] {
  const names: string[] = []
  for (const match of listNamesOutput.matchAll(/string "([^"]+)"/g)) {
    if (match[1].startsWith(MPRIS_PREFIX)) names.push(match[1])
  }
  return names
}

/** The string inside a `variant string "..."` reply, or null when the reply has none. */
export function parseVariantString(output: string): string | null {
  const match = /variant\s+string "([^"]*)"/.exec(output)
  return match ? match[1] : null
}

/** "Spotify" from org.mpris.MediaPlayer2.spotify, minus a browser's ".instance123" suffix. */
export function playerNameFromBusName(busName: string): string {
  const raw = busName.slice(MPRIS_PREFIX.length).replace(/\.instance\d+$/, '')
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

export class LinuxMprisBackend implements NowPlayingBackend {
  constructor(private readonly run: RunCommand = runCommand) {}

  async probe(): Promise<NowPlayingPlayer | null> {
    const listed = await this.run(DBUS_SEND, [
      '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames',
    ])
    for (const busName of parseMprisBusNames(listed)) {
      let status: string | null
      try {
        status = parseVariantString(await this.getProperty(busName, PLAYER_INTERFACE, 'PlaybackStatus'))
      } catch {
        continue // Gone between the listing and the question.
      }
      if (status !== 'Playing') continue
      return { id: busName, name: await this.identity(busName) }
    }
    return null
  }

  async pause(playerId: string): Promise<void> {
    await this.call(playerId, 'Pause')
  }

  async play(playerId: string): Promise<void> {
    await this.call(playerId, 'Play')
  }

  /** The player's own display name, falling back to its bus name. */
  private async identity(busName: string): Promise<string> {
    try {
      return parseVariantString(await this.getProperty(busName, ROOT_INTERFACE, 'Identity')) || playerNameFromBusName(busName)
    } catch {
      return playerNameFromBusName(busName)
    }
  }

  private getProperty(busName: string, iface: string, property: string): Promise<string> {
    return this.run(DBUS_SEND, [
      '--session', '--print-reply', `--dest=${busName}`, MPRIS_PATH,
      'org.freedesktop.DBus.Properties.Get', `string:${iface}`, `string:${property}`,
    ])
  }

  private call(busName: string, method: 'Pause' | 'Play'): Promise<string> {
    return this.run(DBUS_SEND, ['--session', '--print-reply', `--dest=${busName}`, MPRIS_PATH, `${PLAYER_INTERFACE}.${method}`])
  }
}
