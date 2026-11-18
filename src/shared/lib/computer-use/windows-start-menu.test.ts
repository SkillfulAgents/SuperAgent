import { describe, expect, it } from 'vitest'
import { findStartMenuApp, waitForActivatedWindow, type ListedWindow } from './windows-start-menu'

const APPS = [
  { name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
]

describe('findStartMenuApp', () => {
  it('finds an app by its display name or its id, in any case', () => {
    expect(findStartMenuApp('calculator', APPS)?.appId).toBe('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')
    expect(findStartMenuApp('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', APPS)?.name).toBe('Spotify')
    expect(findStartMenuApp('Notepad.exe', APPS)?.name).toBe('Notepad')
  })

  it('finds nothing for a name the Start menu does not show', () => {
    expect(findStartMenuApp('Calc', APPS)).toBeUndefined()
  })
})

describe('waitForActivatedWindow', () => {
  const before: ListedWindow[] = [{ id: 'w-1', app_name: 'Code.exe', is_focused: true }]

  it('answers the window that was not there before', async () => {
    const lists = [before, [...before, { id: 'w-2', app_name: 'explorer.exe' }], [...before, { id: 'w-3', app_name: 'CalculatorApp.exe', title: 'Calculator' }]]
    const window = await waitForActivatedWindow(before, async () => lists.shift() ?? [], 1000, undefined, 1)
    expect(window).toMatchObject({ id: 'w-3', app_name: 'CalculatorApp.exe' })
  })

  it('waits for a Store app’s frame to name the app in it', async () => {
    const lists = [
      [...before, { id: 'w-4', app_name: 'ApplicationFrameHost.exe', title: 'Calculator' }],
      [...before, { id: 'w-4', app_name: 'CalculatorApp.exe', title: 'Calculator' }],
    ]
    expect(await waitForActivatedWindow(before, async () => lists.shift() ?? [], 1000, undefined, 1)).toMatchObject({ id: 'w-4', app_name: 'CalculatorApp.exe' })
    const framedOnly = [...before, { id: 'w-5', app_name: 'ApplicationFrameHost.exe' }]
    expect(await waitForActivatedWindow(before, async () => framedOnly, 5, undefined, 1)).toMatchObject({ id: 'w-5' })
  })

  it('answers an already running app that took focus', async () => {
    const running: ListedWindow[] = [...before, { id: 'w-9', app_name: 'Spotify.exe' }]
    const focused: ListedWindow[] = [{ id: 'w-1', app_name: 'Code.exe' }, { id: 'w-9', app_name: 'Spotify.exe', is_focused: true }]
    expect(await waitForActivatedWindow(running, async () => focused, 1000, undefined, 1)).toMatchObject({ id: 'w-9' })
  })

  it('answers null when no window came up in time, or the call was stopped', async () => {
    expect(await waitForActivatedWindow(before, async () => before, 5, undefined, 1)).toBeNull()
    const stop = new AbortController()
    stop.abort()
    expect(await waitForActivatedWindow(before, async () => before, 60_000, stop.signal, 1)).toBeNull()
  })
})
