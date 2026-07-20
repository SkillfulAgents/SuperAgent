import { describe, expect, it } from 'vitest'

import {
  deriveMacBundlePath,
  extractNonceFromFileName,
  extractNoncesFromHdiutilPlist,
  extractNonceFromUrlText,
  extractNonceFromWhereFromsHex,
} from './download-nonce-service'

const NONCE = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4'

describe('extractNonceFromFileName', () => {
  it('finds the code in a stamped Windows installer name', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-Setup-${NONCE}.exe`)).toBe(NONCE)
  })

  it('finds the code in a stamped DMG name', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-arm64-${NONCE}.dmg`)).toBe(NONCE)
  })

  it('survives browser duplicate-download suffixes', () => {
    expect(extractNonceFromFileName(`Gamut-1.2.3-Setup-${NONCE} (1).exe`)).toBe(NONCE)
  })

  it('works on full paths', () => {
    expect(extractNonceFromFileName(`/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`)).toBe(NONCE)
  })

  it('normalizes uppercase hex', () => {
    expect(extractNonceFromFileName(`Gamut-Setup-${NONCE.toUpperCase()}.exe`)).toBe(NONCE)
  })

  it('rejects unstamped names', () => {
    expect(extractNonceFromFileName('Gamut-1.2.3-Setup.exe')).toBeNull()
    expect(extractNonceFromFileName('Gamut-1.2.3-arm64.dmg')).toBeNull()
  })

  it('rejects hex runs that are too short or embedded in longer words', () => {
    expect(extractNonceFromFileName('Gamut-deadbeef.dmg')).toBeNull()
    expect(extractNonceFromFileName(`Gamut-x${NONCE}.dmg`)).toBeNull()
  })
})

describe('extractNonceFromUrlText', () => {
  it('finds the dl query param', () => {
    expect(
      extractNonceFromUrlText(`https://updates.gamutagents.com/download/mac?dl=${NONCE}`),
    ).toBe(NONCE)
  })

  it('finds it among other params', () => {
    expect(
      extractNonceFromUrlText(`https://x.test/download/win?v=1&dl=${NONCE}&utm=y`),
    ).toBe(NONCE)
  })

  it('ignores lookalike params and invalid codes', () => {
    expect(extractNonceFromUrlText(`https://x.test/?adl=${NONCE}`)).toBeNull()
    expect(extractNonceFromUrlText('https://x.test/?dl=nothex')).toBeNull()
  })
})

describe('extractNonceFromWhereFromsHex', () => {
  it('recovers the code from xattr hex output of a binary plist', () => {
    // Real kMDItemWhereFroms values are binary plists; the URL is stored as a
    // plain UTF-8 run inside, which is all the parser relies on.
    const fakePlist = Buffer.concat([
      Buffer.from('bplist00\xa2\x01\x02_\x10', 'latin1'),
      Buffer.from(`https://updates.gamutagents.com/download/mac?dl=${NONCE}`),
      Buffer.from('_\x10https://platform.gamutagents.com/', 'latin1'),
    ])
    const hex = fakePlist
      .toString('hex')
      .replace(/(..)/g, '$1 ')
      .trim()
    expect(extractNonceFromWhereFromsHex(hex)).toBe(NONCE)
  })

  it('returns null for empty or malformed output', () => {
    expect(extractNonceFromWhereFromsHex('')).toBeNull()
    expect(extractNonceFromWhereFromsHex('zz zz')).toBeNull()
  })
})

describe('extractNoncesFromHdiutilPlist', () => {
  const plist = (...imagePaths: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>images</key><array>${imagePaths
    .map(
      (p) => `<dict>
    <key>image-path</key><string>${p}</string>
    <key>system-entities</key><array><dict>
      <key>mount-point</key><string>/Volumes/Gamut</string>
    </dict></array>
  </dict>`,
    )
    .join('')}</array>
</dict></plist>`

  it('recovers the code from a mounted stamped DMG', () => {
    expect(
      extractNoncesFromHdiutilPlist(plist(`/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`)),
    ).toEqual([NONCE])
  })

  it('returns every stamped product DMG — a stale mount must not shadow a fresh one', () => {
    const STALE = 'ffff'.repeat(12)
    expect(
      extractNoncesFromHdiutilPlist(
        plist(
          `/Users/x/Downloads/Gamut-1.2.2-${STALE}.dmg`,
          `/Users/x/Downloads/Gamut-1.2.3-${NONCE}.dmg`,
        ),
      ),
    ).toEqual([STALE, NONCE])
  })

  it('ignores non-product DMGs even when their names carry hex runs', () => {
    expect(
      extractNoncesFromHdiutilPlist(plist(`/Users/x/Downloads/OtherApp-${NONCE}.dmg`)),
    ).toEqual([])
  })

  it('ignores unstamped product DMGs and non-DMG strings', () => {
    expect(extractNoncesFromHdiutilPlist(plist('/Users/x/Downloads/Gamut-1.2.3.dmg'))).toEqual([])
    expect(extractNoncesFromHdiutilPlist('<string>/Volumes/whatever</string>')).toEqual([])
  })
})

describe('deriveMacBundlePath', () => {
  it('extracts the bundle root from a packaged executable path', () => {
    expect(deriveMacBundlePath('/Applications/Gamut.app/Contents/MacOS/Gamut')).toBe(
      '/Applications/Gamut.app',
    )
  })

  it('returns null outside a bundle', () => {
    expect(deriveMacBundlePath('/usr/local/bin/node')).toBeNull()
  })
})
