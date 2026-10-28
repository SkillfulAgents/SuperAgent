// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, renderHook } from '@testing-library/react'
import { setVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { frameSeconds, mediaKeyAction, useMediaKeys } from './use-media-keys'

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  return mediaKeyAction(event)
}

describe('mediaKeyAction', () => {
  it("maps YouTube's keys", () => {
    expect(press(' ')).toEqual({ type: 'toggle' })
    expect(press('k')).toEqual({ type: 'toggle' })
    expect(press('j')).toEqual({ type: 'seek', seconds: -10 })
    expect(press('l')).toEqual({ type: 'seek', seconds: 10 })
    expect(press('ArrowLeft', { shiftKey: true })).toEqual({ type: 'seek', seconds: -5 })
    expect(press('ArrowRight')).toEqual({ type: 'step', direction: 1 })
    expect(press(',')).toEqual({ type: 'step', direction: -1 })
    expect(press('>', { shiftKey: true })).toEqual({ type: 'rate', direction: 1 })
    expect(press(',', { shiftKey: true })).toEqual({ type: 'rate', direction: -1 })
    expect(press('C')).toEqual({ type: 'comment', listen: false })
    expect(press('m')).toEqual({ type: 'comment', listen: true })
    expect(press('x')).toBeNull()
  })

  it('leaves Space to a focused button; K still toggles', () => {
    const button = document.createElement('button')
    expect(press(' ', {}, button)).toBeNull()
    expect(press('k', {}, button)).toEqual({ type: 'toggle' })
  })

  it('leaves text fields, app shortcuts and handled keys alone', () => {
    const textarea = document.createElement('textarea')
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    expect(press('k', {}, textarea)).toBeNull()
    expect(press(' ', {}, editor)).toBeNull()
    expect(press('c', { metaKey: true })).toBeNull()
    expect(press('j', { ctrlKey: true })).toBeNull()

    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })
    handled.preventDefault()
    expect(mediaKeyAction(handled)).toBeNull()
  })

  it('still works on the seek slider, not inside an open menu or dialog', () => {
    const slider = document.createElement('input')
    slider.type = 'range'
    expect(press('ArrowLeft', {}, slider)).toEqual({ type: 'step', direction: -1 })

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    expect(press('k', {}, dialog.appendChild(document.createElement('div')))).toBeNull()
    expect(press('c', {}, menu)).toBeNull()
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    expect(press('k', {}, listbox)).toBeNull()
  })
})

describe('frameSeconds', () => {
  it('divides by the frames shown, so a skipped callback is not one long frame', () => {
    expect(frameSeconds({ mediaTime: 1, presentedFrames: 10 }, { mediaTime: 1.1, presentedFrames: 13 })).toBeCloseTo(1 / 30, 9)
    expect(frameSeconds({ mediaTime: 1, presentedFrames: 10 }, { mediaTime: 1.1, presentedFrames: 10 })).toBeNull()
    expect(frameSeconds({ mediaTime: 5, presentedFrames: 10 }, { mediaTime: 1, presentedFrames: 11 })).toBeNull()
  })
})

describe('useMediaKeys', () => {
  afterEach(() => vi.restoreAllMocks())

  it('steps one frame paused, toggles once per hold, and stops listening on unmount', () => {
    const video = document.createElement('video')
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    video.currentTime = 2
    const { unmount } = renderHook(() => useMediaKeys({ current: video }, { frameStep: () => 0.25 }))

    fireEvent.keyDown(window, { key: '.' })
    expect(pause).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(2.25)

    fireEvent.keyDown(window, { key: ' ' })
    fireEvent.keyDown(window, { key: ' ', repeat: true })
    expect(play).toHaveBeenCalledOnce()

    unmount()
    fireEvent.keyDown(window, { key: '.' })
    expect(video.currentTime).toBe(2.25)
  })

  it('while voice mode is on, takes Space only from focus inside the player; K always plays', () => {
    const player = document.body.appendChild(document.createElement('div'))
    player.setAttribute('data-media-player', '')
    const video = player.appendChild(document.createElement('video'))
    const slider = player.appendChild(document.createElement('input'))
    slider.type = 'range'
    const voiceFrame = document.body.appendChild(document.createElement('div'))
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    renderHook(() => useMediaKeys({ current: video }, {}))
    setVoiceModeActive('session-1', true)
    try {
      expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(true)
      expect(fireEvent.keyDown(voiceFrame, { key: ' ' })).toBe(true)
      expect(play).not.toHaveBeenCalled()
      fireEvent.keyDown(document.body, { key: 'k' })
      expect(play).toHaveBeenCalledOnce()
      fireEvent.keyDown(slider, { key: ' ' })
      expect(play).toHaveBeenCalledTimes(2)
    } finally {
      setVoiceModeActive('session-1', false)
      player.remove()
      voiceFrame.remove()
    }
  })
})
