/* Generate the branded .agent / .skill document icons (agent|skill .icns/.ico).
 *
 * Renders an SVG document icon (white page + folded corner + Gamut app mark +
 * extension label) at every size needed for macOS .icns and Windows .ico,
 * using Playwright's Chromium so text/vector rendering is crisp per size.
 * Small sizes (<=64px) use a simplified variant without the label.
 *
 * Usage (macOS only — needs iconutil; ImageMagick for .ico):
 *   node build/file-icons/make-icons.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { chromium } = require('playwright')

const REPO = path.join(__dirname, '..', '..')
const OUT = __dirname
const appIconB64 = fs.readFileSync(path.join(REPO, 'build/icon.png')).toString('base64')

function pageSvg({ label, labelStyle, simple }) {
  // 1024x1024 canvas. Page: 740x960 centered, folded top-right corner.
  const fold = 170
  const px = 142, py = 32, pw = 740, ph = 960, rx = simple ? 72 : 48
  const pr = px + pw, pb = py + ph
  const stroke = simple ? 20 : 8
  const labelText = (fill) =>
    `<text x="510" y="808" font-size="64" font-weight="700" letter-spacing="7" fill="${fill}" text-anchor="middle" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif">${label}</text>`
  const labelPill = labelStyle === 'solid'
    ? `<rect x="${512 - 190}" y="724" width="380" height="120" rx="60" fill="#1B1B1F"/>${labelText('#FFFFFF')}`
    : `<rect x="${512 - 190}" y="724" width="380" height="120" rx="60" fill="#FFFFFF" stroke="#1B1B1F" stroke-width="10"/>${labelText('#1B1B1F')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="pageShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
    <linearGradient id="foldGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#D9D9DF"/>
    </linearGradient>
  </defs>
  <!-- page with folded top-right corner -->
  <path filter="url(#pageShadow)" fill="#FFFFFF" stroke="#C4C4CC" stroke-width="${stroke}"
    d="M ${px + rx} ${py}
       H ${pr - fold}
       L ${pr} ${py + fold}
       V ${pb - rx} Q ${pr} ${pb} ${pr - rx} ${pb}
       H ${px + rx} Q ${px} ${pb} ${px} ${pb - rx}
       V ${py + rx} Q ${px} ${py} ${px + rx} ${py} Z"/>
  <!-- fold -->
  <path fill="url(#foldGrad)" stroke="#C4C4CC" stroke-width="${stroke}" stroke-linejoin="round"
    d="M ${pr - fold} ${py} L ${pr} ${py + fold} H ${pr - fold + 24} Q ${pr - fold} ${py + fold} ${pr - fold} ${py + fold - 24} Z"/>
  <!-- Gamut app mark -->
  <image href="data:image/png;base64,${appIconB64}"
    x="${simple ? 262 : 302}" y="${simple ? 262 : 300}" width="${simple ? 500 : 420}" height="${simple ? 500 : 420}"/>
  ${simple ? '' : labelPill}
</svg>`
}

const VARIANTS = {
  agent: { label: 'AGENT', labelStyle: 'solid' },
  skill: { label: 'SKILL', labelStyle: 'outline' },
}

// macOS iconset entries: [filename, pixels]. <=64px renders use the simplified SVG.
const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-icons-'))
  const browser = await chromium.launch()
  for (const [name, cfg] of Object.entries(VARIANTS)) {
    const iconsetDir = path.join(tmp, `${name}.iconset`)
    fs.mkdirSync(iconsetDir, { recursive: true })

    const renderCache = new Map() // px -> buffer
    const render = async (px) => {
      if (renderCache.has(px)) return renderCache.get(px)
      const simple = px <= 64
      const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 })
      await page.setContent(`<style>*{margin:0;padding:0}svg{display:block;width:${px}px;height:${px}px}</style>${pageSvg({ ...cfg, simple })}`)
      const buf = await page.screenshot({ omitBackground: true })
      await page.close()
      renderCache.set(px, buf)
      return buf
    }

    for (const [file, px] of ICONSET) fs.writeFileSync(path.join(iconsetDir, file), await render(px))
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(OUT, `${name}.icns`)])

    const icoPngs = []
    for (const px of ICO_SIZES) {
      const p = path.join(tmp, `${name}-${px}.png`)
      fs.writeFileSync(p, await render(px))
      icoPngs.push(p)
    }
    execFileSync('magick', [...icoPngs, path.join(OUT, `${name}.ico`)])
    console.log(`wrote ${name}.icns + ${name}.ico`)
  }
  await browser.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
