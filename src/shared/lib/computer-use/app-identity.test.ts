import { describe, expect, it } from 'vitest'
import { appKey, sameApp } from './app-identity'

describe('sameApp', () => {
  it('on Windows, matches an image name with or without .exe, in any case', () => {
    expect(sameApp('notepad', 'Notepad.exe', 'win32')).toBe(true)
    expect(sameApp('CalculatorApp.EXE', 'calculatorapp', 'win32')).toBe(true)
    expect(sameApp('notepad', 'notepad++.exe', 'win32')).toBe(false)
    expect(appKey(' Code.exe ', 'win32')).toBe('code')
  })

  it('elsewhere, matches names as written', () => {
    expect(sameApp('Notes', 'Notes', 'darwin')).toBe(true)
    expect(sameApp('notes', 'Notes', 'darwin')).toBe(false)
    expect(sameApp('Notes', 'Notes.exe', 'darwin')).toBe(false)
  })
})
