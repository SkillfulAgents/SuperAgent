/**
 * Bounded retry for the Alpine package step of WSL2 provisioning.
 *
 * A freshly imported WSL2 distro frequently has DNS that is still settling:
 * `apk update` / `apk add` in the provision script then fails with a temporary
 * name-resolution or index-fetch error. One-shot provisioning treated that as
 * fatal, unregistered the distro, and surfaced an unactionable
 * "Provision script failed (exit 1): <raw stderr>" (Sentry ELECTRON-14).
 *
 * This module deliberately imports no `child_process`/Sentry/Electron code so
 * the classification, redaction, backoff, and retry budget are unit-testable
 * without spawning `wsl`. The caller injects the single attempt (and, in tests,
 * the sleep/clock/jitter source).
 */

import { RunnerSetupError, alpineIndexUnreachableError } from './wsl2-setup-errors'

/** Whether an apk failure is worth another attempt. */
export type ApkFailureClass = 'transient' | 'permanent' | 'unrecognized'

/** Which host the failing fetch was aimed at — a class, never the URL itself. */
export type MirrorHostClass = 'alpine-cdn' | 'other-host' | 'none'

/**
 * Hard-permanent apk failures: retrying cannot change the outcome, and they
 * outrank any transient marker that happens to also be in the output.
 */
const HARD_PERMANENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['unsatisfiable-constraints', /unsatisfiable constraints/i],
  ['disk-full', /no space left on device|out of disk space|disk full/i],
  ['read-only-fs', /read-only file system/i],
  ['not-permitted', /operation not permitted/i],
]

/**
 * Transient apk/DNS failures — the ELECTRON-14 signatures. Only these are
 * retried.
 */
const TRANSIENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['apk-temporary-error', /temporary error \(try again later\)/i],
  ['dns-temporary-failure', /temporary failure in name resolution/i],
  [
    'dns-no-resolve',
    /could not resolve|name does not resolve|bad address|no address associated with hostname|non-recoverable failure in name resolution/i,
  ],
  ['network-unreachable', /network (is )?unreachable/i],
  ['host-unreachable', /no route to host|host is unreachable/i],
  ['connection-reset', /connection reset by peer|connection refused/i],
  ['timed-out', /timed out|timeout/i],
  ['server-5xx', /server returned error: http\/[\d.]+ 5\d\d/i],
  ['server-429', /server returned error: http\/[\d.]+ 429/i],
  // A truncated/HTML-substituted index (captive portal, proxy error page) fails
  // signature verification rather than the download itself.
  ['untrusted-signature', /untrusted signature/i],
  ['bad-index', /(bad|invalid|truncated) apkindex|unexpected end of file|premature end/i],
  ['tls-handshake', /(ssl|tls)[^\n]*(handshake|routines)[^\n]*(fail|error)/i],
  // `apk update` could not fetch an index at all: it warns per repository and
  // reports the count as unavailable.
  ['index-unavailable', /warning:\s*ignoring\s+\S+/i],
  ['repos-unavailable', /\b\d+ unavailable\b/i],
]

/**
 * Soft-permanent apk failures. On their own these mean the request itself is
 * impossible (typo'd package, dropped from the repo). But they are ALSO how a
 * failed `apk update` surfaces one step later — apk keeps going with a stale or
 * empty index and then reports the package as missing. So they only count as
 * permanent when no transient/index marker is present.
 */
const SOFT_PERMANENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['unable-to-select-packages', /unable to select packages/i],
  ['no-such-package', /no such package/i],
]

/** Cap on stderr retained from a provisioning attempt before redaction. */
export const MAX_PROVISION_STDERR_CAPTURE_BYTES = 8 * 1024

/** Cap on the redacted excerpt carried into errors, the UI, and telemetry. */
export const MAX_STDERR_EXCERPT_CHARS = 240

/** Bounded, privacy-safe description of one failed provisioning attempt. */
export interface ApkFailureSummary {
  classification: ApkFailureClass
  /** Matched pattern names — never raw stderr content. */
  codes: string[]
  mirrorHostClass: MirrorHostClass
  /** Redacted + truncated stderr. Safe for telemetry and for showing the user. */
  stderrExcerpt: string
  /** Size of the original stderr (a number, not its content). */
  stderrBytes: number
  exitCode: number | null
}

function matchCodes(
  stderr: string,
  patterns: ReadonlyArray<readonly [string, RegExp]>,
): string[] {
  return patterns.filter(([, re]) => re.test(stderr)).map(([code]) => code)
}

/**
 * Classify apk/DNS stderr as worth retrying or not. Precedence:
 *   1. hard-permanent (disk full, unsatisfiable constraints, …) → permanent
 *   2. transient DNS/index/network markers → transient
 *   3. soft-permanent (no such package) → permanent
 *   4. anything else → unrecognized (treated as fatal: we retry only what we
 *      recognize as transient)
 */
export function classifyApkFailure(stderr: string): ApkFailureClass {
  const text = stderr || ''
  if (matchCodes(text, HARD_PERMANENT_PATTERNS).length > 0) return 'permanent'
  if (matchCodes(text, TRANSIENT_PATTERNS).length > 0) return 'transient'
  if (matchCodes(text, SOFT_PERMANENT_PATTERNS).length > 0) return 'permanent'
  return 'unrecognized'
}

/**
 * Classify the host of the first URL mentioned in the output. Only a class is
 * kept — never the URL, its path, or its query string (which can carry mirror
 * tokens).
 */
export function classifyMirrorHostClass(stderr: string): MirrorHostClass {
  const match = (stderr || '').match(/https?:\/\/([^/\s'"?#]+)/i)
  if (!match) return 'none'
  return /(^|\.)alpinelinux\.org$/i.test(match[1]) ? 'alpine-cdn' : 'other-host'
}

/**
 * Strip identifying detail out of apk stderr and truncate it.
 *
 * Removed: URLs (with their paths and query strings), IP addresses, and
 * filesystem paths — which is where usernames, host DNS configuration, mirror
 * tokens, and distro/Windows paths would otherwise leak. What survives is apk's
 * own wording plus package names.
 */
export function redactApkStderr(stderr: string, maxChars = MAX_STDERR_EXCERPT_CHARS): string {
  let text = (stderr || '').replace(/\0/g, '')
  // URLs first: replaced by their host class so the mirror identity is coarse.
  text = text.replace(/(?:https?|ftp):\/\/[^\s'"]+/gi, (url) =>
    `<${classifyMirrorHostClass(url)}>`)
  // Bare IPv4/IPv6 literals (resolv.conf nameservers, gateway addresses).
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
  text = text.replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<ip>')
  // Windows paths (C:\Users\<name>\…) and POSIX paths (/home/<name>, /mnt/c/…).
  text = text.replace(/\b[A-Za-z]:\\[^\s'"]*/g, '<path>')
  text = text.replace(/(?:\/[A-Za-z0-9._@%+-]+){2,}\/?/g, '<path>')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}...`
  }
  return text
}

/** Build the bounded telemetry summary for a failed provisioning attempt. */
export function summarizeApkFailure(stderr: string, exitCode: number | null): ApkFailureSummary {
  const text = stderr || ''
  const classification = classifyApkFailure(text)
  const codes =
    classification === 'permanent'
      ? [...matchCodes(text, HARD_PERMANENT_PATTERNS), ...matchCodes(text, SOFT_PERMANENT_PATTERNS)]
      : matchCodes(text, TRANSIENT_PATTERNS)
  return {
    classification,
    codes,
    mirrorHostClass: classifyMirrorHostClass(text),
    stderrExcerpt: redactApkStderr(text),
    stderrBytes: text.length,
    exitCode,
  }
}

/**
 * One failed run of the provision script. Carries only the bounded summary —
 * the raw stderr is dropped here so it can never reach a log, an error message,
 * or Sentry.
 */
export class ProvisionAttemptError extends Error {
  readonly summary: ApkFailureSummary

  constructor(exitCode: number | null, stderr: string) {
    const summary = summarizeApkFailure(stderr, exitCode)
    super(
      `Provision script failed (exit ${exitCode ?? 'unknown'})` +
      (summary.stderrExcerpt ? `: ${summary.stderrExcerpt}` : '')
    )
    this.name = 'ProvisionAttemptError'
    this.summary = summary
  }
}

/**
 * Typed terminal failure: every allowed attempt hit a transient Alpine
 * index/DNS error. Extends RunnerSetupError so the existing remediation
 * plumbing (client-factory → renderer panel) renders it unchanged.
 */
export class AlpineIndexUnreachableError extends RunnerSetupError {
  readonly summary: ApkFailureSummary
  readonly attempts: number
  readonly elapsedMs: number

  constructor(summary: ApkFailureSummary, attempts: number, elapsedMs: number) {
    super(alpineIndexUnreachableError(summary.stderrExcerpt))
    this.name = 'AlpineIndexUnreachableError'
    this.summary = summary
    this.attempts = attempts
    this.elapsedMs = elapsedMs
  }
}

export interface ApkRetryPolicy {
  /** Total attempts, including the first (so 4 = 1 try + 3 retries). */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Wall-clock ceiling for the whole sequence, including the attempts. */
  totalBudgetMs: number
}

export const DEFAULT_APK_RETRY_POLICY: ApkRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 15_000,
  totalBudgetMs: 90_000,
}

/**
 * Capped exponential backoff with jitter. Jitter spans the lower half of the
 * window ([delay/2, delay)) so a fleet of clients retrying after the same WSL
 * DNS hiccup doesn't synchronize on the mirror.
 */
export function computeApkRetryDelayMs(
  failedAttempt: number,
  policy: ApkRetryPolicy = DEFAULT_APK_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, failedAttempt - 1)
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent)
  return Math.round(capped / 2 + random() * (capped / 2))
}

export interface ApkRetryEvent {
  /** The attempt that just failed (1-based). */
  attempt: number
  delayMs: number
  codes: string[]
  mirrorHostClass: MirrorHostClass
  exitCode: number | null
}

export interface ApkRetryOutcome {
  attempts: number
  delaysMs: number[]
  elapsedMs: number
}

export interface ApkRetryOptions {
  /**
   * Runs one full provisioning attempt. Must be idempotent — the provision
   * script re-runs from the top on every attempt.
   */
  attempt: (attemptNumber: number) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  policy?: ApkRetryPolicy
  onRetry?: (event: ApkRetryEvent) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `attempt` until it succeeds, retrying ONLY recognized transient apk/DNS
 * failures under a bounded attempt count and wall-clock budget.
 *
 * - permanent / unrecognized failures reject immediately with the original error
 * - a transient failure that runs out of attempts or budget rejects with a typed
 *   {@link AlpineIndexUnreachableError}
 */
export async function runProvisionWithApkRetry(options: ApkRetryOptions): Promise<ApkRetryOutcome> {
  const policy = options.policy ?? DEFAULT_APK_RETRY_POLICY
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random

  const startedAt = now()
  const delaysMs: number[] = []

  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      await options.attempt(attemptNumber)
      return { attempts: attemptNumber, delaysMs, elapsedMs: now() - startedAt }
    } catch (err) {
      const summary = err instanceof ProvisionAttemptError ? err.summary : null
      // Only failures we recognize as transient are retryable; everything else
      // (permanent apk errors, spawn failures, unrecognized output) is fatal.
      if (!summary || summary.classification !== 'transient') throw err

      const elapsedMs = now() - startedAt
      const delayMs = computeApkRetryDelayMs(attemptNumber, policy, random)
      const attemptsLeft = attemptNumber < policy.maxAttempts
      const withinBudget = elapsedMs + delayMs <= policy.totalBudgetMs
      if (!attemptsLeft || !withinBudget) {
        throw new AlpineIndexUnreachableError(summary, attemptNumber, elapsedMs)
      }

      options.onRetry?.({
        attempt: attemptNumber,
        delayMs,
        codes: summary.codes,
        mirrorHostClass: summary.mirrorHostClass,
        exitCode: summary.exitCode,
      })
      delaysMs.push(delayMs)
      await sleep(delayMs)
    }
  }
}
