import { describe, it, expect } from 'vitest'
import { parseApkIndex, resolvePackages, satisfiesSpec } from '../../../../scripts/lib/alpine-packages'
import limaPackages from './lima-packages.json'

// A trimmed APKINDEX in Alpine's format (fields per record, blank-line separated).
const COMMUNITY = `C:Q1abc=
P:nerdctl
V:2.1.6-r9
A:aarch64
S:10580783
D:ca-certificates containerd so:libc.musl-aarch64.so.1
p:cmd:nerdctl=2.1.6-r9

C:Q1def=
P:containerd
V:2.2.0-r8
A:aarch64
S:17224957
D:runc !containerd-legacy so:libc.musl-aarch64.so.1
p:cmd:containerd=2.2.0-r8

P:runc
V:1.4.0-r6
S:3000000
D:so:libseccomp.so.2
p:oci-runtime

P:crun
V:1.28-r0
S:400000
p:oci-runtime

P:containerd-next
V:2.20.1-r0
S:1000
`
const MAIN = `P:musl
V:1.2.5-r24
S:400000
p:so:libc.musl-aarch64.so.1=1

P:ca-certificates
V:20261020-r0
S:180000
D:/bin/sh

P:busybox-binsh
V:1.37.0-r30
S:1000
p:/bin/sh cmd:sh=1.37.0-r30

P:libseccomp
V:2.6.1-r0
S:30000
p:so:libseccomp.so.2=2.6.1
`
const index = [...parseApkIndex(COMMUNITY, 'community'), ...parseApkIndex(MAIN, 'main')]
const names = (specs: string[]) => resolvePackages(index, specs).map((e) => e.name)

describe('parseApkIndex', () => {
  it('reads name, version, size, dependencies, provides and repository', () => {
    const nerdctl = index.find((e) => e.name === 'nerdctl')
    expect(nerdctl).toEqual({
      name: 'nerdctl',
      version: '2.1.6-r9',
      size: 10580783,
      depends: ['ca-certificates', 'containerd', 'so:libc.musl-aarch64.so.1'],
      provides: ['cmd:nerdctl'],
      installIf: [],
      repo: 'community',
    })
  })
})

describe('resolvePackages install_if', () => {
  // apk adds an install_if package by itself once everything it names is
  // installed; the bundle must carry the ones this install triggers.
  const withInstallIf = [
    ...index,
    ...parseApkIndex([
      'P:openrc\nV:0.63-r1\nS:1\n',
      'P:alpine-base\nV:3.23.3-r0\nS:1\nD:openrc busybox-binsh\n',
      'P:containerd-openrc-ext\nV:1-r0\nS:1\ni:openrc containerd=2.2.0-r8\n',
      'P:containerd-doc\nV:2.2.0-r8\nS:1\ni:docs containerd=2.2.0-r8\n',
      'P:acpid-openrc\nV:2.0.34-r7\nS:1\ni:openrc acpid\n',
      'P:openrc-base-extra\nV:1-r0\nS:1\ni:openrc alpine-base\n',
      'P:containerd-openrc-ext-chained\nV:1-r0\nS:1\ni:containerd-openrc-ext\n',
    ].join('\n'), 'main'),
  ]
  const resolved = () => resolvePackages(withInstallIf, ['containerd~=2.2'], ['alpine-base']).map((e) => e.name)

  it('brings an install_if package whose conditions are met by the base image plus this install', () => {
    // i:openrc containerd — openrc from alpine-base, containerd from the bundle.
    expect(resolved()).toContain('containerd-openrc-ext')
  })

  it('and one triggered by such a package in turn', () => {
    expect(resolved()).toContain('containerd-openrc-ext-chained')
  })

  it('leaves out one with a condition nothing installs (docs) or this install does not touch (acpid)', () => {
    expect(resolved()).not.toContain('containerd-doc')
    expect(resolved()).not.toContain('acpid-openrc')
  })

  it('leaves out one the base image alone triggers: it is already there', () => {
    expect(resolved()).not.toContain('openrc-base-extra')
  })

  it('does not bundle the base image itself', () => {
    expect(resolved()).not.toContain('alpine-base')
    expect(resolved()).not.toContain('openrc')
  })
})

describe('satisfiesSpec', () => {
  it.each([
    ['containerd~=2.2', '2.2.0-r8', true],
    ['containerd~=2.2', '2.2', true],
    ['containerd~=2.2', '2.20.1-r0', false],
    ['containerd~=2.2', '2.3.0-r0', false],
    ['containerd-openrc', '9.9.9-r0', true],
  ])('%s with %s → %s', (spec, version, expected) => {
    expect(satisfiesSpec(spec, version)).toBe(expected)
  })

  it('rejects operators it does not implement rather than ignoring them', () => {
    expect(() => satisfiesSpec('containerd>=2.2', '2.2.0')).toThrow(/Unsupported package spec/)
  })
})

describe('resolvePackages', () => {
  it('brings every dependency transitively, through so:/path provides, ignoring conflicts', () => {
    expect(names(['nerdctl~=2.1'])).toEqual([
      'busybox-binsh', 'ca-certificates', 'containerd', 'libseccomp', 'musl', 'nerdctl', 'runc',
    ])
  })

  it('brings every provider of a virtual dependency, since apk picks one at install time', () => {
    const withVirtual = [...index, ...parseApkIndex('P:shim\nV:1-r0\nS:1\nD:oci-runtime\n', 'main')]
    expect(resolvePackages(withVirtual, ['shim']).map((e) => e.name)).toEqual(expect.arrayContaining(['runc', 'crun']))
  })

  it('fails the build when a requested package has a version outside its spec', () => {
    expect(() => names(['containerd~=2.3'])).toThrow('Package "containerd" is 2.2.0-r8 in the Alpine index, which does not satisfy "containerd~=2.3"')
  })

  it('fails the build when a requested package is missing', () => {
    expect(() => names(['podman'])).toThrow('Package "podman" is not in the Alpine index')
  })

  it('fails the build when a dependency has no provider', () => {
    const broken = [...index, ...parseApkIndex('P:needy\nV:1-r0\nS:1\nD:so:libnothing.so.9\n', 'main')]
    expect(() => resolvePackages(broken, ['needy'])).toThrow('Nothing in the Alpine index provides "so:libnothing.so.9" (needed by needy)')
  })
})

describe('lima-packages.json', () => {
  it('lists specs the resolver understands', () => {
    expect(limaPackages.packages.length).toBeGreaterThan(0)
    for (const spec of limaPackages.packages) expect(() => satisfiesSpec(spec, '0')).not.toThrow()
  })
})
