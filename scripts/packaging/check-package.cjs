const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const asar = require('@electron/asar')
const { asarEntrySchema } = require('./package-schema.cjs')

const sqliteRoot = 'node_modules/better-sqlite3/'
const sqliteBinary = `${sqliteRoot}build/Release/better_sqlite3.node`
const entryPoints = ['package.json', 'dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html', `${sqliteRoot}package.json`, `${sqliteRoot}lib/index.js`]

function archiveFiles(header) {
  const files = []
  function walk(entry, prefix = '', unpacked = false) {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const file = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, file, unpacked || child.unpacked)
      else if (child.size !== undefined) files.push({ path: file, size: child.size, unpacked: !!(unpacked || child.unpacked) })
    }
  }
  walk(asarEntrySchema.parse(header))
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function checkFiles(files) {
  const unexpected = files.filter(({ path: file }) => {
    if (!/^(?:dist\/(?:main|preload|renderer)\/|node_modules\/|package\.json$)/.test(file)) return true
    if (file.startsWith('node_modules/') && /(?:\.map|\.d\.(?:ts|mts|cts))$/.test(file)) return true
    if (file.startsWith(sqliteRoot)) {
      const relative = file.slice(sqliteRoot.length)
      return !/^(?:lib\/.*\.js|package\.json|LICENSE|build\/Release\/better_sqlite3\.node)$/.test(relative)
    }
    return false
  })
  const missing = [...entryPoints, sqliteBinary].filter(file => !files.some(entry => entry.path === file))
  if (unexpected.length || missing.length) {
    throw new Error(`Invalid desktop package contents. Unexpected (${unexpected.length}): ${unexpected.slice(0, 20).map(file => file.path).join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}`)
  }
  if (!files.find(file => file.path === sqliteBinary).unpacked) throw new Error('SQLite native binary must be unpacked')
}

function checkWindowsArchitecture(binary, arch) {
  const machines = { x64: 0x8664, arm64: 0xaa64 }
  if (binary.length < 64 || binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('SQLite binary is not a Windows PE file')
  const offset = binary.readUInt32LE(0x3c)
  if (offset + 6 > binary.length || binary.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid SQLite PE header')
  const machine = binary.readUInt16LE(offset + 4)
  if (!machines[arch] || machine !== machines[arch]) throw new Error(`SQLite architecture mismatch: expected ${arch}, got PE machine 0x${machine.toString(16)}`)
}

async function nativeInputFiles(directory, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await nativeInputFiles(file, relative))
    else if (entry.isFile()) files.push({ path: relative, size: (await fs.stat(file)).size })
  }
  return files
}

async function afterPack(context) {
  const arch = require('builder-util').Arch[context.arch]
  const platform = context.electronPlatformName
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const archive = path.join(resources, 'app.asar')
  const files = archiveFiles(asar.getRawHeader(archive).header)
  const nativeInput = await nativeInputFiles(path.join(context.packager.info.appDir, 'node_modules', 'better-sqlite3', 'build'))
  const reportPath = path.join(context.outDir, `package-contents-${platform}-${arch}.txt`)
  const lines = [
    `Platform: ${platform}/${arch}; Node: ${process.version}; Electron: ${context.packager.info.framework.version}`,
    'SQLite build inputs before packaging (prebuilt extraction can leave earlier compiler output here):',
    ...nativeInput.sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => `${file.size}\t${file.path}`),
    'Packaged files: bytes\tunpacked\tpath',
    ...files.map(file => `${file.size}\t${file.unpacked}\t${file.path}`),
  ]
  // Save the inventory before enforcing it so a failed build retains evidence.
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`)
  console.log(`Package inventory: ${reportPath}; ${files.length} files, ${(files.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MiB`)
  checkFiles(files)
  const binary = await fs.readFile(path.join(resources, 'app.asar.unpacked', sqliteBinary))
  if (platform === 'win32') checkWindowsArchitecture(binary, arch)
  console.log(`SQLite ${platform}/${arch}: ${binary.length} bytes; SHA256 before signing: ${createHash('sha256').update(binary).digest('hex')}`)
}

module.exports = afterPack
module.exports.archiveFiles = archiveFiles
module.exports.checkFiles = checkFiles
module.exports.checkWindowsArchitecture = checkWindowsArchitecture
