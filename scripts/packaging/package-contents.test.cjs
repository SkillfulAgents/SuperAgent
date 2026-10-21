const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const asar = require('@electron/asar')
const { Arch } = require('builder-util')
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config')
const { getMainFileMatchers, getNodeModuleFileMatcher, excludedExts } = require('app-builder-lib/out/fileMatcher')
const { AppFileWalker } = require('app-builder-lib/out/util/AppFileWalker')
const { NodeModuleCopyHelper } = require('app-builder-lib/out/util/NodeModuleCopyHelper')
const afterPack = require('./check-package.cjs')
const { checkFiles, checkWindowsArchitecture } = afterPack
const { packageSchema } = require('./package-schema.cjs')

const repoRoot = path.resolve(__dirname, '../..')
// eslint-disable-next-line no-template-curly-in-string -- electron-builder's literal architecture macro.
const archMacro = '${arch}'
const sqliteRoot = 'node_modules/better-sqlite3/'
const runtimeFiles = ['LICENSE', 'package.json', 'lib/index.js', 'lib/database.js', 'build/Release/better_sqlite3.node']
const compilerFiles = [
  'deps/sqlite3/sqlite3.c', 'src/better_sqlite3.cpp',
  'build/Release/test_extension.node', 'build/Release/sqlite3.lib',
  'build/Release/better_sqlite3.lib', 'build/Release/better_sqlite3.exp',
  'build/Release/obj/global_intermediate/sqlite3/sqlite3.c',
  'build/Debug/better_sqlite3.node', 'build/config.gypi',
  'bin/win32-x64-145/better-sqlite3.node',
]

async function configuration() {
  try {
    const pkg = packageSchema.parse(JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')))
    return doMergeConfigs([pkg.build])
  } catch (cause) {
    throw new Error('Cannot read the desktop packaging configuration', { cause })
  }
}

function packager(config, appDir) {
  return {
    config, appInfo: { type: 'commonjs' },
    info: { config, projectDir: appDir, buildResourcesDir: 'build', debugLogger: { isEnabled: false } },
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-package-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function write(root, file, content = 'fixture') {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), content)
}

for (const platform of ['win', 'mac']) {
  for (const arch of ['x64', 'arm64']) {
    test(`${platform}/${arch} packages compiled app files without repository sources or stale web builds`, async () => {
      const config = await configuration()
      const expand = value => value.replaceAll(archMacro, arch)
      const builder = packager(config, repoRoot)
      // Config normalization turns the common files into a FileSet. A platform
      // files array containing only exclusions becomes a separate matcher that
      // defaults to **/*. Exercise normalization and both matchers, not just a
      // hand-picked minimatch against the common dist/ inclusion.
      const matchers = getMainFileMatchers(repoRoot, '/destination', expand, config[platform], builder, path.join(repoRoot, 'release'), false)
      const walkers = matchers.map(matcher => new AppFileWalker(matcher, builder))
      const included = file => walkers.some(walker => walker.filter(path.join(repoRoot, file), { isDirectory: () => false }))
      for (const file of ['package.json', 'dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html', 'dist/renderer/assets/icon.svg']) {
        assert.equal(included(file), true, file)
      }
      for (const file of ['src/main/index.ts', 'e2e/test.spec.ts', '.claude/skills/example/SKILL.md', 'agent-container/src/server.ts', 'docs/example.md', 'dist/web/server.mjs']) {
        assert.equal(included(file), false, file)
      }

      const dependencyFilter = getNodeModuleFileMatcher(repoRoot, '/destination', expand, config[platform], builder.info).createFilter()
      const dependencyIncluded = file => dependencyFilter(path.join(repoRoot, file), { isDirectory: () => false })
      assert.equal(dependencyIncluded('node_modules/zod/index.js'), true)
      for (const file of ['node_modules/zod/index.js.map', 'node_modules/zod/index.d.cts', 'node_modules/zod/index.d.mts']) assert.equal(dependencyIncluded(file), false, file)
      const daemon = `node_modules/@skillful-agents/agent-computer/bin/ac-core-${platform === 'win' ? 'win32' : 'darwin'}-${arch}${platform === 'win' ? '.exe' : ''}`
      assert.equal(dependencyIncluded(daemon), true)
      if (platform === 'win') {
        assert.equal(dependencyIncluded(`node_modules/@skillful-agents/agent-computer/bin/ac-core-win32-${arch === 'x64' ? 'arm64' : 'x64'}.exe`), false)
        assert.equal(dependencyIncluded('node_modules/@skillful-agents/agent-computer/bin/ac-core-darwin-arm64'), false)
      }
    })
  }
}

test('prebuilt and source-built SQLite inputs produce the same runtime package through the real file collector', async t => {
  const root = await fixture(t)
  const config = await configuration()
  const builder = packager(config, root)
  const matcher = getNodeModuleFileMatcher(root, '/destination', value => value.replaceAll(archMacro, 'x64'), config.win, builder.info)
  const moduleDir = path.join(root, sqliteRoot)
  const collect = async () => {
    const collector = new NodeModuleCopyHelper(matcher, builder)
    const files = await collector.collectNodeModules({ name: 'better-sqlite3', dir: moduleDir }, excludedExts.split(',').map(ext => `.${ext}`), 'node_modules/better-sqlite3')
    return files.map(file => path.relative(moduleDir, file).split(path.sep).join('/')).sort()
  }
  for (const file of runtimeFiles.filter(file => file !== 'package.json')) await write(moduleDir, file)
  await write(moduleDir, 'package.json', JSON.stringify(packageSchema.parse({ name: 'better-sqlite3', version: '12.8.0', main: 'lib/index.js' })))
  const prebuilt = await collect()
  assert.deepEqual(prebuilt, [...runtimeFiles].sort())
  for (const file of compilerFiles) await write(moduleDir, file)
  // prebuild-install extracts over the same directory: it replaces the .node,
  // leaving the earlier source build's libraries, test extension and bin/ copy.
  await write(moduleDir, 'build/Release/better_sqlite3.node', 'next-architecture-prebuilt')
  assert.deepEqual(await collect(), prebuilt)
})

function windowsBinary(arch) {
  const binary = Buffer.alloc(128)
  binary.write('MZ')
  binary.writeUInt32LE(64, 0x3c)
  binary.write('PE\0\0', 64)
  binary.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  return binary
}

test('the package guard rejects repository files, maps and native leftovers, and requires the runtime binary', () => {
  const good = ['package.json', 'dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html', `${sqliteRoot}package.json`, `${sqliteRoot}lib/index.js`, `${sqliteRoot}build/Release/better_sqlite3.node`]
    .map(file => ({ path: file, size: 1, unpacked: file.endsWith('.node') }))
  assert.doesNotThrow(() => checkFiles(good))
  for (const file of ['src/main/index.ts', 'dist/web/server.mjs', 'node_modules/zod/index.js.map', ...compilerFiles.map(file => sqliteRoot + file)]) {
    assert.throws(() => checkFiles([...good, { path: file, size: 1 }]), /Unexpected \(1\):/)
  }
  assert.throws(() => checkFiles(good.slice(0, -1)), /Missing:.*better_sqlite3/)
  assert.throws(() => checkFiles(good.map(file => ({ ...file, unpacked: false }))), /must be unpacked/)
})

test('native architecture validation catches a stale binary from the previous architecture', () => {
  for (const arch of ['x64', 'arm64']) assert.doesNotThrow(() => checkWindowsArchitecture(windowsBinary(arch), arch))
  assert.throws(() => checkWindowsArchitecture(windowsBinary('x64'), 'arm64'), /architecture mismatch/)
  assert.throws(() => checkWindowsArchitecture(Buffer.from('invalid'), 'x64'), /not a Windows PE/)
})

test('afterPack checks the actual archive and retains a local inventory when validation fails', async t => {
  const root = await fixture(t)
  const app = path.join(root, 'app')
  const resources = path.join(root, 'output', 'resources')
  await fs.mkdir(resources, { recursive: true })
  for (const file of ['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html', `${sqliteRoot}lib/index.js`]) await write(app, file)
  await write(app, 'package.json', JSON.stringify(packageSchema.parse({ name: 'test-app', version: '1.0.0', main: 'dist/main/index.js' })))
  await write(app, `${sqliteRoot}package.json`, JSON.stringify(packageSchema.parse({ name: 'better-sqlite3', version: '12.8.0', main: 'lib/index.js' })))
  await write(app, `${sqliteRoot}build/Release/better_sqlite3.node`, windowsBinary('x64'))
  await asar.createPackageWithOptions(app, path.join(resources, 'app.asar'), { unpack: '**/*.node' })
  const context = {
    arch: Arch.x64, electronPlatformName: 'win32', appOutDir: path.join(root, 'output'), outDir: root,
    packager: { info: { appDir: app, framework: { version: '41.1.0' } } },
  }
  await afterPack(context)
  await write(app, 'src/accidental-source.ts')
  await asar.createPackageWithOptions(app, path.join(resources, 'app.asar'), { unpack: '**/*.node' })
  await assert.rejects(afterPack(context), /accidental-source/)
  assert.match(await fs.readFile(path.join(root, 'package-contents-win32-x64.txt'), 'utf8'), /src\/accidental-source.ts/)
})
