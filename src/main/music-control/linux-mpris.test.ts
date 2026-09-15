import { describe, it, expect, vi } from 'vitest'
import { DBUS_SEND, LinuxMprisBackend, parseMprisBusNames, parseVariantString, playerNameFromBusName } from './linux-mpris'

const LIST_NAMES = `method return time=1.0 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2
   array [
      string "org.freedesktop.DBus"
      string ":1.7"
      string "org.mpris.MediaPlayer2.spotify"
      string "org.mpris.MediaPlayer2.chromium.instance4242"
      string "org.gnome.Shell"
   ]
`
const variant = (value: string) => `method return time=1.0 sender=:1.7 -> destination=:1.9 serial=5 reply_serial=2\n   variant       string "${value}"\n`

/** A fake session bus: which players exist and what each says. */
function bus(players: Record<string, { status: string; identity?: string }>) {
  const calls: string[][] = []
  const run = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args)
    if (args.includes('org.freedesktop.DBus.ListNames')) {
      const names = Object.keys(players).map((n) => `      string "${n}"`).join('\n')
      return `   array [\n${names}\n   ]\n`
    }
    const dest = args.find((a) => a.startsWith('--dest='))!.slice('--dest='.length)
    const player = players[dest]
    if (!player) throw new Error(`Error org.freedesktop.DBus.Error.ServiceUnknown: The name ${dest} was not provided by any .service files`)
    if (args.includes('string:PlaybackStatus')) return variant(player.status)
    if (args.includes('string:Identity')) {
      if (!player.identity) throw new Error('no identity')
      return variant(player.identity)
    }
    return 'method return\n'
  })
  return { run, calls }
}

describe('MPRIS parsing', () => {
  it('picks the player bus names out of ListNames', () => {
    expect(parseMprisBusNames(LIST_NAMES)).toEqual(['org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.chromium.instance4242'])
  })

  it('reads a string variant and tolerates a reply without one', () => {
    expect(parseVariantString(variant('Playing'))).toBe('Playing')
    expect(parseVariantString('method return\n')).toBeNull()
  })

  it('names a player from its bus name, dropping a browser instance suffix', () => {
    expect(playerNameFromBusName('org.mpris.MediaPlayer2.spotify')).toBe('Spotify')
    expect(playerNameFromBusName('org.mpris.MediaPlayer2.chromium.instance4242')).toBe('Chromium')
  })
})

describe('LinuxMprisBackend', () => {
  it('finds the first player that is playing and calls it by its own name', async () => {
    const { run } = bus({
      'org.mpris.MediaPlayer2.vlc': { status: 'Paused', identity: 'VLC media player' },
      'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' },
    })
    await expect(new LinuxMprisBackend(run).probe()).resolves.toEqual({ id: 'org.mpris.MediaPlayer2.spotify', name: 'Spotify' })
  })

  it('falls back to the bus name when a player has no Identity', async () => {
    const { run } = bus({ 'org.mpris.MediaPlayer2.mpv': { status: 'Playing' } })
    await expect(new LinuxMprisBackend(run).probe()).resolves.toEqual({ id: 'org.mpris.MediaPlayer2.mpv', name: 'Mpv' })
  })

  it('reports nothing when every player is paused or gone', async () => {
    const { run } = bus({ 'org.mpris.MediaPlayer2.vlc': { status: 'Stopped' } })
    await expect(new LinuxMprisBackend(run).probe()).resolves.toBeNull()
    const vanished = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('org.freedesktop.DBus.ListNames')) return '      string "org.mpris.MediaPlayer2.gone"\n'
      throw new Error('ServiceUnknown')
    })
    await expect(new LinuxMprisBackend(vanished).probe()).resolves.toBeNull()
  })

  it('pauses and plays the named player over the session bus', async () => {
    const { run, calls } = bus({ 'org.mpris.MediaPlayer2.spotify': { status: 'Playing' } })
    const backend = new LinuxMprisBackend(run)
    await backend.pause('org.mpris.MediaPlayer2.spotify')
    await backend.play('org.mpris.MediaPlayer2.spotify')
    expect(run).toHaveBeenCalledWith(DBUS_SEND, expect.arrayContaining(['org.mpris.MediaPlayer2.Player.Pause']))
    expect(calls.at(-1)).toEqual([
      '--session', '--print-reply', '--dest=org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Play',
    ])
  })
})
