import { describe, it, expect, vi } from 'vitest'
import {
  AlpineIndexUnreachableError,
  DEFAULT_APK_RETRY_POLICY,
  MAX_STDERR_EXCERPT_CHARS,
  ProvisionAttemptError,
  classifyApkFailure,
  classifyMirrorHostClass,
  computeApkRetryDelayMs,
  redactApkStderr,
  runProvisionWithApkRetry,
  summarizeApkFailure,
  type ApkRetryEvent,
  type ApkRetryPolicy,
} from './wsl2-provision-retry'
import { RunnerSetupError, alpineIndexUnreachableError } from './wsl2-setup-errors'

// ============================================================================
// Real Alpine/apk stderr from the ELECTRON-14 occurrences (a freshly imported
// WSL2 distro whose DNS is still settling) plus the permanent counterparts.
// Kept verbatim so a regression in the classifier shows up as a failure.
// ============================================================================

const STDERR = {
  // apk 2.14 when the index fetch fails DNS resolution.
  temporaryError: `fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz
WARNING: Ignoring https://dl-cdn.alpinelinux.org/alpine/v3.23/main: temporary error (try again later)
fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/community/x86_64/APKINDEX.tar.gz
WARNING: Ignoring https://dl-cdn.alpinelinux.org/alpine/v3.23/community: temporary error (try again later)
2 errors; 0 distinct packages available`,

  dnsFailure: `fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: Temporary failure in name resolution
ERROR: unable to select packages:
  containerd (no such package):
    required by: world[containerd]`,

  networkUnreachable: `fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: Network unreachable`,

  untrustedSignature: `ERROR: https://dl-cdn.alpinelinux.org/alpine/v3.23/main: UNTRUSTED signature`,

  timedOut: `fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz: Connection timed out`,

  serverError: `WARNING: Ignoring https://dl-cdn.alpinelinux.org/alpine/v3.23/main: server returned error: HTTP/1.1 503 Service Unavailable`,

  // ---- permanent ----
  unsatisfiable: `ERROR: unsatisfiable constraints:
  containerd-9.9.9 (missing):
    required by: world[containerd=9.9.9]`,

  noSuchPackage: `ERROR: unable to select packages:
  nerdctl-typo (no such package):
    required by: world[nerdctl-typo]`,

  diskFull: `ERROR: containerd-2.0.0-r0: No space left on device`,

  // Both a permanent disk failure and a stray timeout: permanent must win.
  diskFullWithTimeout: `fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main: Connection timed out
ERROR: buildkit-0.20.0-r0: No space left on device`,

  unrecognized: `sh: line 12: something entirely novel went wrong`,
}

// ============================================================================
// classifyApkFailure
// ============================================================================

describe('classifyApkFailure', () => {
  it('treats the ELECTRON-14 apk/DNS signatures as transient', () => {
    expect(classifyApkFailure(STDERR.temporaryError)).toBe('transient')
    expect(classifyApkFailure(STDERR.dnsFailure)).toBe('transient')
    expect(classifyApkFailure(STDERR.networkUnreachable)).toBe('transient')
    expect(classifyApkFailure(STDERR.untrustedSignature)).toBe('transient')
    expect(classifyApkFailure(STDERR.timedOut)).toBe('transient')
    expect(classifyApkFailure(STDERR.serverError)).toBe('transient')
  })

  it('treats permanent apk errors as permanent', () => {
    expect(classifyApkFailure(STDERR.unsatisfiable)).toBe('permanent')
    expect(classifyApkFailure(STDERR.noSuchPackage)).toBe('permanent')
    expect(classifyApkFailure(STDERR.diskFull)).toBe('permanent')
  })

  it('lets a hard-permanent failure outrank a transient marker in the same output', () => {
    expect(classifyApkFailure(STDERR.diskFullWithTimeout)).toBe('permanent')
  })

  it('treats "no such package" caused by a failed index fetch as transient, not permanent', () => {
    // apk keeps going after a failed `apk update` and then reports the package
    // as missing — retrying the whole (idempotent) script is the right move.
    expect(classifyApkFailure(STDERR.dnsFailure)).toBe('transient')
  })

  it('does not retry output it does not recognize', () => {
    expect(classifyApkFailure(STDERR.unrecognized)).toBe('unrecognized')
    expect(classifyApkFailure('')).toBe('unrecognized')
  })
})

// ============================================================================
// Privacy: mirror host class + stderr redaction
// ============================================================================

describe('classifyMirrorHostClass', () => {
  it('classifies the Alpine CDN without keeping the URL', () => {
    expect(classifyMirrorHostClass(STDERR.temporaryError)).toBe('alpine-cdn')
  })

  it('classifies a non-Alpine host (corporate mirror/proxy) as other-host', () => {
    expect(classifyMirrorHostClass('fetch https://apk.corp.internal/alpine/main: timed out')).toBe('other-host')
  })

  it('reports none when no URL is present', () => {
    expect(classifyMirrorHostClass(STDERR.diskFull)).toBe('none')
    expect(classifyMirrorHostClass('')).toBe('none')
  })
})

describe('redactApkStderr', () => {
  it('replaces mirror URLs (and their query strings) with a host class', () => {
    const redacted = redactApkStderr(
      'fetch https://mirror.corp.example.com/alpine/v3.23/main/x86_64/APKINDEX.tar.gz?token=s3cr3t&user=rob: timed out'
    )
    expect(redacted).not.toContain('token=s3cr3t')
    expect(redacted).not.toContain('mirror.corp.example.com')
    expect(redacted).not.toContain('https://')
    expect(redacted).toContain('<other-host>')
    expect(redacted).toContain('timed out')
  })

  it('strips usernames and filesystem paths (Windows and in-distro)', () => {
    const redacted = redactApkStderr(
      'ERROR: /mnt/c/Users/rob.smith/AppData/Roaming/superagent/wsl2 unavailable; C:\\Users\\rob.smith\\x.log; /etc/apk/repositories missing'
    )
    expect(redacted).not.toContain('rob.smith')
    expect(redacted).not.toContain('AppData')
    expect(redacted).not.toContain('/etc/apk/repositories')
    expect(redacted).toContain('<path>')
  })

  it('strips nameserver / gateway IP addresses (host DNS configuration)', () => {
    const redacted = redactApkStderr('nameserver 10.255.255.254 unreachable, tried 1.1.1.1 and fe80::1ff:fe23:4567')
    expect(redacted).not.toContain('10.255.255.254')
    expect(redacted).not.toContain('1.1.1.1')
    expect(redacted).not.toContain('fe80::1ff:fe23:4567')
    expect(redacted).toContain('<ip>')
  })

  it('truncates to the excerpt cap', () => {
    const redacted = redactApkStderr('temporary error (try again later) '.repeat(200))
    expect(redacted.length).toBeLessThanOrEqual(MAX_STDERR_EXCERPT_CHARS + 3)
    expect(redacted.endsWith('...')).toBe(true)
  })

  it('drops null bytes from UTF-16LE-tainted output', () => {
    expect(redactApkStderr('a\0p\0k\0')).toBe('apk')
  })
})

// ============================================================================
// summarizeApkFailure — the telemetry payload
// ============================================================================

describe('summarizeApkFailure', () => {
  it('carries classified codes, a host class, and only a redacted excerpt', () => {
    const summary = summarizeApkFailure(STDERR.temporaryError, 1)

    expect(summary.classification).toBe('transient')
    expect(summary.codes).toContain('apk-temporary-error')
    expect(summary.mirrorHostClass).toBe('alpine-cdn')
    expect(summary.exitCode).toBe(1)
    // Size is retained as a number; the content is not.
    expect(summary.stderrBytes).toBe(STDERR.temporaryError.length)
    expect(summary.stderrExcerpt.length).toBeLessThanOrEqual(MAX_STDERR_EXCERPT_CHARS + 3)
    expect(summary.stderrExcerpt).not.toContain('dl-cdn.alpinelinux.org')
    expect(summary.stderrExcerpt).not.toContain('/alpine/v3.23')
  })

  it('names the permanent code for a permanent failure', () => {
    const summary = summarizeApkFailure(STDERR.unsatisfiable, 1)
    expect(summary.classification).toBe('permanent')
    expect(summary.codes).toContain('unsatisfiable-constraints')
  })
})

describe('ProvisionAttemptError', () => {
  it('keeps only the bounded summary — never the raw stderr', () => {
    const err = new ProvisionAttemptError(1, STDERR.temporaryError)

    expect(err.summary.classification).toBe('transient')
    expect(err.message).toContain('Provision script failed (exit 1)')
    expect(err.message).not.toContain('dl-cdn.alpinelinux.org')
    expect(Object.values(err)).not.toContain(STDERR.temporaryError)
    expect(JSON.stringify(err.summary)).not.toContain('dl-cdn.alpinelinux.org')
  })
})

// ============================================================================
// Backoff
// ============================================================================

describe('computeApkRetryDelayMs', () => {
  const policy: ApkRetryPolicy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 4_000, totalBudgetMs: 60_000 }

  it('grows exponentially and caps at maxDelayMs', () => {
    const noJitter = () => 1
    expect(computeApkRetryDelayMs(1, policy, noJitter)).toBe(1_000)
    expect(computeApkRetryDelayMs(2, policy, noJitter)).toBe(2_000)
    expect(computeApkRetryDelayMs(3, policy, noJitter)).toBe(4_000)
    expect(computeApkRetryDelayMs(4, policy, noJitter)).toBe(4_000)
    expect(computeApkRetryDelayMs(9, policy, noJitter)).toBe(4_000)
  })

  it('jitters within the lower half of the window', () => {
    expect(computeApkRetryDelayMs(2, policy, () => 0)).toBe(1_000)
    expect(computeApkRetryDelayMs(2, policy, () => 0.5)).toBe(1_500)
    expect(computeApkRetryDelayMs(2, policy, () => 1)).toBe(2_000)
  })

  it('never exceeds the cap with the default policy', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = computeApkRetryDelayMs(attempt, DEFAULT_APK_RETRY_POLICY, Math.random)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(DEFAULT_APK_RETRY_POLICY.maxDelayMs)
    }
  })
})

// ============================================================================
// runProvisionWithApkRetry — the bounded retry runner
// ============================================================================

describe('runProvisionWithApkRetry', () => {
  const policy: ApkRetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000, totalBudgetMs: 30_000 }

  /** Injectable clock/sleep so no test ever waits on a real timer. */
  function fakeClock() {
    let clock = 0
    const slept: number[] = []
    return {
      now: () => clock,
      random: () => 1,
      sleep: async (ms: number) => { slept.push(ms); clock += ms },
      /** Time consumed by each attempt itself. */
      tick: (ms: number) => { clock += ms },
      slept,
    }
  }

  it('runs the attempt once and never sleeps when provisioning succeeds first try', async () => {
    const clock = fakeClock()
    const attempt = vi.fn().mockResolvedValue(undefined)

    const outcome = await runProvisionWithApkRetry({ attempt, policy, ...clock })

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(1)
    expect(outcome.attempts).toBe(1)
    expect(outcome.delaysMs).toEqual([])
    expect(clock.slept).toEqual([])
  })

  it('retries a transient DNS failure and resolves once a later attempt succeeds', async () => {
    const clock = fakeClock()
    const attempt = vi.fn(async (n: number) => {
      if (n < 3) throw new ProvisionAttemptError(1, STDERR.dnsFailure)
    })
    const onRetry = vi.fn()

    const outcome = await runProvisionWithApkRetry({ attempt, policy, onRetry, ...clock })

    expect(attempt).toHaveBeenCalledTimes(3)
    expect(outcome.attempts).toBe(3)
    // Capped exponential backoff (jitter pinned to the top of the window).
    expect(outcome.delaysMs).toEqual([1_000, 2_000])
    expect(clock.slept).toEqual([1_000, 2_000])
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('reports only bounded codes and a host class to onRetry', async () => {
    const clock = fakeClock()
    const events: ApkRetryEvent[] = []
    const attempt = vi.fn(async (n: number) => {
      if (n === 1) throw new ProvisionAttemptError(1, STDERR.temporaryError)
    })

    await runProvisionWithApkRetry({ attempt, policy, onRetry: (e) => events.push(e), ...clock })

    expect(events).toHaveLength(1)
    expect(events[0].attempt).toBe(1)
    expect(events[0].codes).toContain('apk-temporary-error')
    expect(events[0].mirrorHostClass).toBe('alpine-cdn')
    expect(events[0].exitCode).toBe(1)
    expect(JSON.stringify(events[0])).not.toContain('dl-cdn.alpinelinux.org')
  })

  it('emits a typed alpine-index-unreachable error once the attempt budget is exhausted', async () => {
    const clock = fakeClock()
    const attempt = vi.fn(async () => { throw new ProvisionAttemptError(1, STDERR.temporaryError) })

    const error = await runProvisionWithApkRetry({ attempt, policy, ...clock }).catch((e) => e)

    expect(error).toBeInstanceOf(AlpineIndexUnreachableError)
    expect(error).toBeInstanceOf(RunnerSetupError)
    expect(error.kind).toBe('alpine-index-unreachable')
    expect(error.userResolvable).toBe(true)
    expect(error.attempts).toBe(policy.maxAttempts)
    expect(attempt).toHaveBeenCalledTimes(policy.maxAttempts)
    expect(clock.slept).toEqual([1_000, 2_000, 4_000])
    // The payload the UI/Sentry sees carries the redacted excerpt only.
    expect(error.toPayload().originalStderr).not.toContain('dl-cdn.alpinelinux.org')
    expect(error.toPayload().originalStderr.length).toBeLessThanOrEqual(MAX_STDERR_EXCERPT_CHARS + 3)
    expect(error.summary.codes).toContain('apk-temporary-error')
  })

  it('emits the typed error when the wall-clock budget is exhausted before the attempts are', async () => {
    const clock = fakeClock()
    // Each attempt burns 14s, so the 30s budget runs out after two attempts even
    // though maxAttempts allows four.
    const attempt = vi.fn(async () => {
      clock.tick(14_000)
      throw new ProvisionAttemptError(1, STDERR.timedOut)
    })

    const error = await runProvisionWithApkRetry({ attempt, policy, ...clock }).catch((e) => e)

    expect(error).toBeInstanceOf(AlpineIndexUnreachableError)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(error.attempts).toBe(2)
    expect(error.elapsedMs).toBeLessThanOrEqual(policy.totalBudgetMs)
  })

  it('fails immediately on a permanent apk error — no retry, no sleep', async () => {
    const clock = fakeClock()
    const permanent = new ProvisionAttemptError(1, STDERR.unsatisfiable)
    const attempt = vi.fn(async () => { throw permanent })
    const onRetry = vi.fn()

    const error = await runProvisionWithApkRetry({ attempt, policy, onRetry, ...clock }).catch((e) => e)

    // The original error propagates untouched — not the typed network error.
    expect(error).toBe(permanent)
    expect(error).not.toBeInstanceOf(AlpineIndexUnreachableError)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(clock.slept).toEqual([])
  })

  it('fails immediately on other permanent apk errors (missing package, disk full)', async () => {
    for (const stderr of [STDERR.noSuchPackage, STDERR.diskFull, STDERR.diskFullWithTimeout]) {
      const clock = fakeClock()
      const attempt = vi.fn(async () => { throw new ProvisionAttemptError(1, stderr) })

      await expect(runProvisionWithApkRetry({ attempt, policy, ...clock })).rejects.toThrow(
        'Provision script failed'
      )
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(clock.slept).toEqual([])
    }
  })

  it('does not retry unrecognized failures or non-provision errors (e.g. spawn ENOENT)', async () => {
    const clock = fakeClock()
    const unrecognized = new ProvisionAttemptError(2, STDERR.unrecognized)
    const unrecognizedAttempt = vi.fn(async () => { throw unrecognized })
    await expect(runProvisionWithApkRetry({ attempt: unrecognizedAttempt, policy, ...clock })).rejects.toBe(
      unrecognized
    )
    expect(unrecognizedAttempt).toHaveBeenCalledTimes(1)

    const spawnFailure = Object.assign(new Error('spawn wsl ENOENT'), { code: 'ENOENT' })
    const spawnAttempt = vi.fn(async () => { throw spawnFailure })
    await expect(runProvisionWithApkRetry({ attempt: spawnAttempt, policy, ...clock })).rejects.toBe(spawnFailure)
    expect(spawnAttempt).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })

  it('keeps the default policy bounded (attempts and total budget)', () => {
    expect(DEFAULT_APK_RETRY_POLICY.maxAttempts).toBeGreaterThan(1)
    expect(DEFAULT_APK_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(6)
    expect(DEFAULT_APK_RETRY_POLICY.totalBudgetMs).toBeLessThanOrEqual(120_000)
  })
})

// ============================================================================
// The new remediation payload
// ============================================================================

describe('alpineIndexUnreachableError', () => {
  it('is a user-resolvable network remediation with actionable steps', () => {
    const payload = alpineIndexUnreachableError('WARNING: Ignoring <alpine-cdn>: temporary error (try again later)')

    expect(payload.kind).toBe('alpine-index-unreachable')
    expect(payload.title.length).toBeGreaterThan(0)
    expect(payload.remediation.length).toBeGreaterThan(0)
    expect(payload.userResolvable).toBe(true)
    expect(payload.steps.length).toBeGreaterThan(0)
    for (const step of payload.steps) {
      expect(step.label.length).toBeGreaterThan(0)
    }
    expect(payload.steps.some((s) => s.command === 'wsl --shutdown')).toBe(true)
    expect(payload.originalStderr).toContain('temporary error')
  })
})
