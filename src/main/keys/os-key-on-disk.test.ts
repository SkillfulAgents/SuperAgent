import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localStateHasOsKey } from './os-key-on-disk'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-key-on-disk-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const writeLocalState = (text: string) => fs.writeFileSync(path.join(dir, 'Local State'), text)

describe('localStateHasOsKey', () => {
  it('is true once Local State holds the key, beside whatever else Chromium keeps there', async () => {
    writeLocalState(JSON.stringify({ os_crypt: { audit_enabled: true, encrypted_key: 'RFBBUEk=' }, windowStates: {} }))
    await expect(localStateHasOsKey(dir)).resolves.toBe(true)
  })

  it('is false with no file, no key, an empty key or a damaged file', async () => {
    await expect(localStateHasOsKey(dir)).resolves.toBe(false)
    writeLocalState(JSON.stringify({ windowStates: {} }))
    await expect(localStateHasOsKey(dir)).resolves.toBe(false)
    writeLocalState(JSON.stringify({ os_crypt: { encrypted_key: '' } }))
    await expect(localStateHasOsKey(dir)).resolves.toBe(false)
    writeLocalState('{"os_crypt":')
    await expect(localStateHasOsKey(dir)).resolves.toBe(false)
  })
})
