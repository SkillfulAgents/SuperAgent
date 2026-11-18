// Resolve a set of Alpine package specs against the repositories' APKINDEX
// files, without apk: the macOS build machine bundles the packages a new Lima
// VM installs on first boot, so the VM never downloads them.

export interface ApkIndexEntry {
  /** P: */
  name: string
  /** V: */
  version: string
  /** S: size of the .apk file in bytes */
  size: number
  /** D: dependency tokens */
  depends: string[]
  /** p: provided tokens, without their =version */
  provides: string[]
  /** i: install_if tokens: apk adds the package once all of these are installed */
  installIf: string[]
  /** Which repository's index listed it (main, community). */
  repo: string
}

/** Parse an uncompressed APKINDEX: blank-line-separated records of `K:value` lines. */
export function parseApkIndex(text: string, repo: string): ApkIndexEntry[] {
  const entries: ApkIndexEntry[] = []
  for (const record of text.split(/\n\s*\n/)) {
    const fields = new Map<string, string>()
    for (const line of record.split('\n')) {
      const m = /^([A-Za-z]):(.*)$/.exec(line)
      if (m) fields.set(m[1], m[2])
    }
    const name = fields.get('P')
    const version = fields.get('V')
    if (!name || !version) continue
    entries.push({
      name,
      version,
      size: Number(fields.get('S') ?? NaN),
      depends: (fields.get('D') ?? '').split(' ').filter(Boolean),
      provides: (fields.get('p') ?? '').split(' ').filter(Boolean).map(tokenName),
      installIf: (fields.get('i') ?? '').split(' ').filter(Boolean),
      repo,
    })
  }
  return entries
}

/** `so:libc.musl-aarch64.so.1=1.2`, `runc>=1.1`, `nerdctl~=2.1` → the name part. */
function tokenName(token: string): string {
  return token.split(/[<>=~]/)[0]
}

/**
 * Does `version` satisfy a spec's constraint? Supports a bare name (any
 * version) and `name~=X` (apk's fuzzy match: X, or X followed by . - or _).
 */
export function satisfiesSpec(spec: string, version: string): boolean {
  const m = /^([^<>=~]+)(?:~=(.+))?$/.exec(spec)
  if (!m) throw new Error(`Unsupported package spec "${spec}" (use "name" or "name~=X.Y")`)
  const prefix = m[2]
  if (prefix === undefined) return true
  return version === prefix || (version.startsWith(prefix) && /^[._-]/.test(version.slice(prefix.length)))
}

/**
 * The packages to bundle for `specs`: each requested package plus everything
 * it depends on, transitively. A dependency with several providers (e.g.
 * oci-runtime → runc, crun) brings all of them, because apk picks one at
 * install time. Packages the base image already has come along too; apk
 * leaves them alone if the installed version satisfies the dependency.
 *
 * Also the install_if packages apk adds by itself during that install: those
 * whose conditions are all installed afterwards, at least one by this install
 * (e.g. buildkit-openrc, `i:openrc buildkit`). Without their files apk fails
 * with "package mentioned in index not found". `base` names what the VM
 * already has, resolved with its dependencies (alpine-base brings openrc).
 *
 * Throws when a requested package is missing or has the wrong version, or a
 * dependency has no provider, so the build fails instead of the VM's first boot.
 */
export function resolvePackages(entries: ApkIndexEntry[], specs: string[], base: string[] = []): ApkIndexEntry[] {
  const byName = new Map<string, ApkIndexEntry>()
  const providers = new Map<string, ApkIndexEntry[]>()
  for (const entry of entries) {
    byName.set(entry.name, entry)
    for (const token of [entry.name, ...entry.provides]) {
      const list = providers.get(token) ?? []
      list.push(entry)
      providers.set(token, list)
    }
  }

  const requested = (spec: string) => {
    const name = tokenName(spec)
    const entry = byName.get(name)
    if (!entry) throw new Error(`Package "${name}" is not in the Alpine index`)
    if (!satisfiesSpec(spec, entry.version)) {
      throw new Error(`Package "${name}" is ${entry.version} in the Alpine index, which does not satisfy "${spec}"`)
    }
    return entry
  }

  /** `start` plus everything it depends on, transitively, added to `into`. */
  const withDependencies = (start: ApkIndexEntry[], into: Map<string, ApkIndexEntry>) => {
    const queue = start.filter((entry) => !into.has(entry.name))
    queue.forEach((entry) => into.set(entry.name, entry))
    while (queue.length > 0) {
      const entry = queue.shift()!
      for (const dep of entry.depends) {
        if (dep.startsWith('!')) continue // a conflict, not a dependency
        const candidates = providers.get(tokenName(dep))
        if (!candidates?.length) throw new Error(`Nothing in the Alpine index provides "${dep}" (needed by ${entry.name})`)
        for (const candidate of candidates) {
          if (into.has(candidate.name)) continue
          into.set(candidate.name, candidate)
          queue.push(candidate)
        }
      }
    }
  }

  const preinstalled = new Map<string, ApkIndexEntry>()
  withDependencies(base.map(requested), preinstalled)
  const selected = new Map<string, ApkIndexEntry>()
  withDependencies(specs.map(requested), selected)

  // install_if: added once every condition is installed, if this install
  // installs at least one of them; repeat, since those can trigger more.
  const namesOf = (packages: Iterable<ApkIndexEntry>) => new Set([...packages].flatMap((e) => [e.name, ...e.provides]))
  for (let added = true; added; ) {
    added = false
    const installed = namesOf([...preinstalled.values(), ...selected.values()])
    const ours = namesOf([...selected.values()].filter((e) => !preinstalled.has(e.name)))
    for (const entry of entries) {
      if (entry.installIf.length === 0 || selected.has(entry.name) || preinstalled.has(entry.name)) continue
      const conditions = entry.installIf.map(tokenName)
      if (!conditions.every((c) => installed.has(c)) || !conditions.some((c) => ours.has(c))) continue
      withDependencies([entry], selected)
      added = true
    }
  }

  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))
}
