import { build } from 'esbuild'
import { builtinModules } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const mode = process.argv[2] ?? 'all'
const targetDirectories = {
  web: ['dist/web'],
  electron: ['dist/main', 'dist/preload'],
  all: ['dist/web', 'dist/main', 'dist/preload'],
}[mode]

if (!targetDirectories) {
  throw new Error(`Unknown runtime-dependency target: ${mode}`)
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const runtimeProvidedPackages = {
  web: new Set(),
  main: new Set(['electron']),
  preload: new Set(['electron']),
}

function rootPackageName(specifier) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    builtins.has(specifier)
  ) {
    return null
  }

  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function listBundles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listBundles(entryPath))
    } else if (/\.(?:c|m)?js$/.test(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

async function externalSpecifiers(bundlePath) {
  // Re-parsing the emitted bundle avoids source-level guesses. Package imports
  // and relative chunks stay external, so esbuild reports the exact runtime
  // edges without resolving or executing them. Only literal specifiers are
  // visible: require(someVariable) never reaches the metafile.
  const result = await build({
    entryPoints: [bundlePath],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    packages: 'external',
    external: ['./*', '../*'],
    treeShaking: false,
    logLevel: 'silent',
  })

  return Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((dependency) => dependency.external)
    .map((dependency) => dependency.path)
}

function parentPackageKey(key) {
  const marker = '/node_modules/'
  const index = key.lastIndexOf(marker)
  return index < 0 ? '' : key.slice(0, index)
}

function resolveLockDependency(packages, parentKey, name) {
  let current = parentKey
  for (;;) {
    const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`
    if (packages[candidate]) return candidate
    if (!current) return null
    current = parentPackageKey(current)
  }
}

function dependencyNames(entry) {
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ])
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (!entry.peerDependenciesMeta?.[name]?.optional) names.add(name)
  }
  return names
}

function productionClosure(packages, directDependencies) {
  const queue = directDependencies
    .map((name) => resolveLockDependency(packages, '', name))
    .filter(Boolean)
  const closure = new Set()

  while (queue.length > 0) {
    const key = queue.shift()
    if (closure.has(key)) continue
    closure.add(key)
    for (const name of dependencyNames(packages[key])) {
      const dependency = resolveLockDependency(packages, key, name)
      if (dependency && !closure.has(dependency)) queue.push(dependency)
    }
  }

  return closure
}

function closureContains(closure, packageName) {
  // Bundles in dist/ resolve bare specifiers from the repo-root node_modules, so
  // only a top-level install counts; a nested-only copy (node_modules/x/node_modules/y)
  // is unreachable from the bundle even though it is in the closure.
  return closure.has(`node_modules/${packageName}`)
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const packageLock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const directDependencies = Object.keys(packageJson.dependencies ?? {})
const closure = productionClosure(packageLock.packages, directDependencies)
const importsByTarget = {}

for (const relativeDirectory of targetDirectories) {
  const target = relativeDirectory.split('/').at(-1)
  const specifiers = new Set()
  const bundlePaths = await listBundles(path.join(repoRoot, relativeDirectory))
  if (bundlePaths.length === 0) {
    throw new Error(`No JavaScript bundles found in ${relativeDirectory}`)
  }
  for (const bundlePath of bundlePaths) {
    for (const specifier of await externalSpecifiers(bundlePath)) specifiers.add(specifier)
  }
  importsByTarget[target] = [...specifiers].sort()
}

const externalPackages = new Set(
  Object.values(importsByTarget).flat().map(rootPackageName).filter(Boolean),
)
const missingPackages = Object.entries(importsByTarget)
  .flatMap(([target, specifiers]) => specifiers.map(rootPackageName).filter(Boolean).map((name) => ({ target, name })))
  .filter(({ target, name }) =>
    !runtimeProvidedPackages[target].has(name) && !closureContains(closure, name),
  )
  .map(({ target, name }) => `${target}:${name}`)
  .sort()

if (missingPackages.length > 0) {
  throw new Error(
    `Built ${mode} output imports packages outside the production dependency closure: ${missingPackages.join(', ')}`,
  )
}

if (mode === 'all') {
  const unusedDirectDependencies = directDependencies
    .filter((name) => !externalPackages.has(name))
    .sort()
  if (unusedDirectDependencies.length > 0) {
    throw new Error(
      `Production dependencies are not externalized by any shipped bundle: ${unusedDirectDependencies.join(', ')}`,
    )
  }
}

console.log(
  `runtime dependency check (${mode}): ${externalPackages.size} external package roots, ` +
  `${directDependencies.length} direct dependencies, ${closure.size} locked packages`,
)
