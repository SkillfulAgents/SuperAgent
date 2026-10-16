/**
 * The page-size cap, tested directly.
 *
 * These are the numbers that decide how much transcript a single request can
 * ask the server to materialize, and the env knobs are the operator's lever for
 * turning that down on a memory-tight deployment. Until now they were only
 * reachable through two route tests, so the fallback behaviour of a malformed
 * or hostile env value — the case that decides whether a bad knob silently
 * raises the ceiling — went unasserted.
 */
import { describe, it, expect, afterEach } from 'vitest'

import {
  capMessagesPageLimit,
  clampMessagesPageBytes,
  MESSAGES_PAGE_BYTES,
  MESSAGES_PAGE_LIMIT,
  MESSAGES_PAGE_MAX_BYTES,
  MESSAGES_PAGE_MIN_BYTES,
  MESSAGES_PAGE_OLDER_LIMIT,
  MESSAGES_PAGE_MAX_LIMIT,
} from './messages-page'

const CURSOR = 'some-message-id'

afterEach(() => {
  delete process.env.MESSAGES_PAGE_LIMIT
  delete process.env.MESSAGES_PAGE_OLDER_LIMIT
})

describe('capMessagesPageLimit — defaults', () => {
  it('falls back to the first-page default when nothing is requested', () => {
    expect(capMessagesPageLimit(undefined)).toBe(MESSAGES_PAGE_LIMIT)
  })

  it('falls back to the older-page default when a cursor is present', () => {
    expect(capMessagesPageLimit(undefined, CURSOR)).toBe(MESSAGES_PAGE_OLDER_LIMIT)
  })

  it('honors a request below the default', () => {
    expect(capMessagesPageLimit(10)).toBe(10)
    expect(capMessagesPageLimit(10, CURSOR)).toBe(10)
  })

  it('caps a request above the default', () => {
    expect(capMessagesPageLimit(10_000)).toBe(MESSAGES_PAGE_LIMIT)
    expect(capMessagesPageLimit(10_000, CURSOR)).toBe(MESSAGES_PAGE_OLDER_LIMIT)
  })

  it('scroll-up pages are smaller than first pages by default', () => {
    // Not incidental: an older page is fetched while the user is already
    // reading, so it trades size for latency.
    expect(MESSAGES_PAGE_OLDER_LIMIT).toBeLessThan(MESSAGES_PAGE_LIMIT)
    expect(MESSAGES_PAGE_LIMIT).toBeLessThanOrEqual(MESSAGES_PAGE_MAX_LIMIT)
  })
})

describe('capMessagesPageLimit — env overrides', () => {
  it('lowers the first-page ceiling from the environment', () => {
    process.env.MESSAGES_PAGE_LIMIT = '25'

    expect(capMessagesPageLimit(undefined)).toBe(25)
    expect(capMessagesPageLimit(500)).toBe(25)
    expect(capMessagesPageLimit(5)).toBe(5)
    // The older-page knob is untouched by the first-page one.
    expect(capMessagesPageLimit(undefined, CURSOR)).toBe(MESSAGES_PAGE_OLDER_LIMIT)
  })

  it('lowers the older-page ceiling from the environment', () => {
    process.env.MESSAGES_PAGE_OLDER_LIMIT = '15'

    expect(capMessagesPageLimit(undefined, CURSOR)).toBe(15)
    expect(capMessagesPageLimit(500, CURSOR)).toBe(15)
    expect(capMessagesPageLimit(undefined)).toBe(MESSAGES_PAGE_LIMIT)
  })

  it('is read per call, so a knob set after startup takes effect', () => {
    expect(capMessagesPageLimit(undefined)).toBe(MESSAGES_PAGE_LIMIT)
    process.env.MESSAGES_PAGE_LIMIT = '7'
    expect(capMessagesPageLimit(undefined)).toBe(7)
  })

  it('never lets the environment raise the ceiling past the hard maximum', () => {
    // The knob is a way to turn the page size DOWN on a memory-tight
    // deployment. An operator who sets it high must not be able to talk the
    // server into materializing an unbounded page.
    process.env.MESSAGES_PAGE_LIMIT = '100000'
    process.env.MESSAGES_PAGE_OLDER_LIMIT = '100000'

    expect(capMessagesPageLimit(undefined)).toBe(MESSAGES_PAGE_MAX_LIMIT)
    expect(capMessagesPageLimit(99_999)).toBe(MESSAGES_PAGE_MAX_LIMIT)
    expect(capMessagesPageLimit(undefined, CURSOR)).toBe(MESSAGES_PAGE_MAX_LIMIT)
  })

  it('ignores a malformed knob rather than treating it as zero', () => {
    // Number('') is 0 and Number('abc') is NaN; either one collapsing to a cap
    // of 0 would serve empty pages forever and hang pagination.
    for (const bad of ['', '   ', 'abc', 'NaN', '0', '-5', '1.5', 'Infinity', '1e3abc']) {
      process.env.MESSAGES_PAGE_LIMIT = bad
      expect(capMessagesPageLimit(undefined)).toBe(MESSAGES_PAGE_LIMIT)
    }
  })

  it('accepts a knob of exactly 1', () => {
    process.env.MESSAGES_PAGE_LIMIT = '1'
    expect(capMessagesPageLimit(undefined)).toBe(1)
    expect(capMessagesPageLimit(300)).toBe(1)
  })

  it('reads an exponent-form knob the way Number does', () => {
    // '1e2' is a valid integer to Number, and envLimit accepts it.
    process.env.MESSAGES_PAGE_LIMIT = '1e2'
    expect(capMessagesPageLimit(undefined)).toBe(100)
  })
})

describe('clampMessagesPageBytes', () => {
  it('leaves an absent budget absent, so the reader applies its default', () => {
    expect(clampMessagesPageBytes(undefined)).toBeUndefined()
  })

  it('honors a budget inside the bounds', () => {
    expect(clampMessagesPageBytes(512 * 1024)).toBe(512 * 1024)
    expect(clampMessagesPageBytes(MESSAGES_PAGE_MIN_BYTES)).toBe(MESSAGES_PAGE_MIN_BYTES)
    expect(clampMessagesPageBytes(MESSAGES_PAGE_MAX_BYTES)).toBe(MESSAGES_PAGE_MAX_BYTES)
  })

  it('raises a tiny budget to the floor', () => {
    // A page of a couple of items would turn reading history into hundreds
    // of requests, each paying its own transcript scan.
    expect(clampMessagesPageBytes(1)).toBe(MESSAGES_PAGE_MIN_BYTES)
    expect(clampMessagesPageBytes(MESSAGES_PAGE_MIN_BYTES - 1)).toBe(MESSAGES_PAGE_MIN_BYTES)
  })

  it('never lets a request raise the window past the server default', () => {
    expect(clampMessagesPageBytes(MESSAGES_PAGE_MAX_BYTES + 1)).toBe(MESSAGES_PAGE_MAX_BYTES)
    expect(clampMessagesPageBytes(Number.MAX_SAFE_INTEGER)).toBe(MESSAGES_PAGE_MAX_BYTES)
  })

  it('keeps the renderer budget a real reduction inside the bounds', () => {
    expect(MESSAGES_PAGE_BYTES).toBeGreaterThanOrEqual(MESSAGES_PAGE_MIN_BYTES)
    expect(MESSAGES_PAGE_BYTES).toBeLessThan(MESSAGES_PAGE_MAX_BYTES)
    expect(clampMessagesPageBytes(MESSAGES_PAGE_BYTES)).toBe(MESSAGES_PAGE_BYTES)
  })
})
