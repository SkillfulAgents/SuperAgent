import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { optimizeServiceIcon } from './lib/optimize-service-icon'

const iconsDir = path.resolve(
  process.cwd(),
  process.argv[2] ?? 'src/renderer/public/service-icons',
)

const iconFiles = readdirSync(iconsDir)
  .filter((fileName) => fileName.endsWith('.svg'))
  .sort()

let beforeBytes = 0
let afterBytes = 0

for (const fileName of iconFiles) {
  const iconPath = path.join(iconsDir, fileName)
  const source = readFileSync(iconPath, 'utf8')
  const optimized = optimizeServiceIcon(source)

  beforeBytes += Buffer.byteLength(source)
  afterBytes += Buffer.byteLength(optimized)
  writeFileSync(iconPath, optimized, 'utf8')
}

const reduction = beforeBytes === 0 ? 0 : (1 - afterBytes / beforeBytes) * 100
console.log(
  `Optimized ${iconFiles.length} service icons: ${beforeBytes} -> ${afterBytes} bytes (-${reduction.toFixed(1)}%)`,
)
