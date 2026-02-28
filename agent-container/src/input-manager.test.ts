import { describe, it, expect, vi } from 'vitest'
import { inputManager } from './input-manager'

describe('InputManager', () => {
  // Tests use the exported singleton but unique toolUseIds per test to avoid cross-contamination.

  describe('normal flow (resolve after createPending)', () => {
    it('resolves a pending secret request', async () => {
      const promise = inputManager.createPending('tool-1', 'API_KEY', 'need it')

      const resolved = inputManager.resolve('tool-1', 'secret-value')
      expect(resolved).toBe(true)

      const value = await promise
      expect(value).toBe('secret-value')
    })

    it('rejects a pending secret request', async () => {
      const promise = inputManager.createPending('tool-2', 'API_KEY', 'need it')

      const rejected = inputManager.reject('tool-2', 'User declined')
      expect(rejected).toBe(true)

      await expect(promise).rejects.toThrow('User declined')
    })

    it('resolves a pending typed request', async () => {
      const promise = inputManager.createPendingWithType<Record<string, string>>(
        'tool-3',
        'connected_account',
        { toolkit: 'github' }
      )

      const resolved = inputManager.resolve('tool-3', { token: 'abc123' })
      expect(resolved).toBe(true)

      const value = await promise
      expect(value).toEqual({ token: 'abc123' })
    })
  })

  describe('early resolution (resolve/reject BEFORE createPending)', () => {
    it('resolves immediately when resolve arrives before createPending', async () => {
      // User answers before the tool handler has registered the pending entry
      const resolved = inputManager.resolve('early-1', 'early-secret')
      expect(resolved).toBe(true)

      // Now the tool handler runs and creates the pending entry
      const value = await inputManager.createPending(
        'early-1',
        'GITHUB_TOKEN',
        'need for auth'
      )
      expect(value).toBe('early-secret')
    })

    it('rejects immediately when reject arrives before createPending', async () => {
      const rejected = inputManager.reject('early-2', 'User declined early')
      expect(rejected).toBe(true)

      await expect(
        inputManager.createPending('early-2', 'SLACK_TOKEN')
      ).rejects.toThrow('User declined early')
    })

    it('resolves immediately when resolve arrives before createPendingWithType', async () => {
      const resolved = inputManager.resolve('early-3', { access_token: 'tok' })
      expect(resolved).toBe(true)

      const value = await inputManager.createPendingWithType<Record<string, string>>(
        'early-3',
        'connected_account',
        { toolkit: 'github' }
      )
      expect(value).toEqual({ access_token: 'tok' })
    })

    it('rejects immediately when reject arrives before createPendingWithType', async () => {
      const rejected = inputManager.reject('early-4', 'Declined account')
      expect(rejected).toBe(true)

      await expect(
        inputManager.createPendingWithType('early-4', 'connected_account')
      ).rejects.toThrow('Declined account')
    })
  })

  describe('parallel tool calls scenario', () => {
    it('handles two parallel secrets where user answers second first', async () => {
      // Simulate: Claude returns two parallel request_secret tool calls (A and B).
      // Tool A's handler runs first and blocks on createPending.
      // The user answers B before B's handler has even started.

      // Tool A registers its pending
      const promiseA = inputManager.createPending(
        'parallel-A',
        'SECRET_A',
        'first secret'
      )

      // User answers B early (before tool B's handler has run)
      const resolvedB = inputManager.resolve('parallel-B', 'value-B')
      expect(resolvedB).toBe(true)

      // User answers A normally
      const resolvedA = inputManager.resolve('parallel-A', 'value-A')
      expect(resolvedA).toBe(true)

      // Tool A's promise resolves
      expect(await promiseA).toBe('value-A')

      // Tool B's handler finally runs - should resolve immediately from buffer
      const promiseB = inputManager.createPending(
        'parallel-B',
        'SECRET_B',
        'second secret'
      )
      expect(await promiseB).toBe('value-B')
    })

    it('handles two parallel secrets where user answers both before handlers run', async () => {
      // Both answers arrive before either tool handler has run

      // User provides both answers early
      inputManager.resolve('both-early-A', 'val-A')
      inputManager.resolve('both-early-B', 'val-B')

      // Both tool handlers now run
      const promiseA = inputManager.createPending('both-early-A', 'KEY_A')
      const promiseB = inputManager.createPending('both-early-B', 'KEY_B')

      expect(await promiseA).toBe('val-A')
      expect(await promiseB).toBe('val-B')
    })

    it('handles mixed: one answered early, one declined normally', async () => {
      // User declines B before its handler runs
      inputManager.reject('mixed-B', 'User declined B')

      // Tool A registers normally, user answers normally
      const promiseA = inputManager.createPending('mixed-A', 'KEY_A')
      inputManager.resolve('mixed-A', 'val-A')
      expect(await promiseA).toBe('val-A')

      // Tool B registers after early rejection
      await expect(
        inputManager.createPending('mixed-B', 'KEY_B')
      ).rejects.toThrow('User declined B')
    })
  })

  describe('toolUseId capture', () => {
    it('set and consume works correctly', () => {
      inputManager.setCurrentToolUseId('capture-1')
      expect(inputManager.consumeCurrentToolUseId()).toBe('capture-1')
      // Second consume returns null (already consumed)
      expect(inputManager.consumeCurrentToolUseId()).toBeNull()
    })
  })

  describe('hasPending', () => {
    it('returns true for pending entries', () => {
      inputManager.createPending('has-1', 'KEY')
      expect(inputManager.hasPending('has-1')).toBe(true)
      // Clean up
      inputManager.resolve('has-1', 'cleanup')
    })

    it('returns false after resolve', () => {
      inputManager.createPending('has-2', 'KEY')
      inputManager.resolve('has-2', 'val')
      expect(inputManager.hasPending('has-2')).toBe(false)
    })

    it('returns false for early-resolved entries (not yet pending)', () => {
      inputManager.resolve('has-3', 'early')
      // Early results are not in the pending map
      expect(inputManager.hasPending('has-3')).toBe(false)
      // Clean up: consume the early result
      inputManager.createPending('has-3', 'KEY')
    })
  })

  describe('getAllPending', () => {
    it('returns all currently pending entries', async () => {
      inputManager.createPending('getall-1', 'KEY_A', 'reason A')
      inputManager.createPending('getall-2', 'KEY_B')

      const pending = inputManager.getAllPending()
      expect(pending).toHaveLength(2)
      expect(pending.map((p) => p.toolUseId).sort()).toEqual([
        'getall-1',
        'getall-2',
      ])

      const entry1 = pending.find((p) => p.toolUseId === 'getall-1')!
      expect(entry1.inputType).toBe('secret')
      expect(entry1.metadata).toEqual({ secretName: 'KEY_A', reason: 'reason A' })
      expect(entry1.createdAt).toBeInstanceOf(Date)

      // Clean up
      inputManager.resolve('getall-1', 'x')
      inputManager.resolve('getall-2', 'x')
    })

    it('does not include early-buffered results', () => {
      inputManager.resolve('getall-early', 'buffered')
      const pending = inputManager.getAllPending()
      expect(pending.find((p) => p.toolUseId === 'getall-early')).toBeUndefined()
      // Clean up
      inputManager.createPending('getall-early', 'KEY')
    })
  })

  describe('cleanupStale', () => {
    it('rejects pending entries older than maxAgeMs', async () => {
      vi.useFakeTimers()
      try {
        const promise = inputManager.createPending('stale-1', 'OLD_KEY')

        // Advance time past the maxAge threshold
        vi.advanceTimersByTime(10_000)
        inputManager.cleanupStale(5_000)

        await expect(promise).rejects.toThrow('Input request timed out')
        expect(inputManager.hasPending('stale-1')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not reject entries younger than maxAgeMs', async () => {
      const promise = inputManager.createPending('fresh-1', 'NEW_KEY')

      // Cleanup with a very large maxAge — nothing should be removed
      inputManager.cleanupStale(999_999_999)
      expect(inputManager.hasPending('fresh-1')).toBe(true)

      // Clean up
      inputManager.resolve('fresh-1', 'x')
      await promise
    })

    it('clears stale early results', () => {
      inputManager.resolve('stale-early-1', 'buffered')
      inputManager.cleanupStale(0)

      // The early result should be gone — createPending should now block normally
      const promise = inputManager.createPending('stale-early-1', 'KEY')
      expect(inputManager.hasPending('stale-early-1')).toBe(true)

      // Clean up
      inputManager.resolve('stale-early-1', 'x')
    })
  })

  describe('early result consumed only once', () => {
    it('second createPending for same toolUseId blocks normally after early result is consumed', async () => {
      inputManager.resolve('once-1', 'early-val')

      // First createPending consumes the early result
      const val = await inputManager.createPending('once-1', 'KEY')
      expect(val).toBe('early-val')

      // Second createPending with the same ID should block (early result gone)
      const promise2 = inputManager.createPending('once-1', 'KEY')
      expect(inputManager.hasPending('once-1')).toBe(true)

      // Clean up
      inputManager.resolve('once-1', 'normal-val')
      expect(await promise2).toBe('normal-val')
    })
  })

  describe('double resolve on same toolUseId', () => {
    it('second resolve buffers as early result after pending was already consumed', async () => {
      const promise = inputManager.createPending('double-1', 'KEY')

      // First resolve — consumes the pending entry
      expect(inputManager.resolve('double-1', 'first')).toBe(true)
      expect(await promise).toBe('first')

      // Second resolve — no pending entry, buffers as early result
      expect(inputManager.resolve('double-1', 'second')).toBe(true)

      // If a new createPending is made with the same ID, it picks up the buffered value
      const val = await inputManager.createPending('double-1', 'KEY')
      expect(val).toBe('second')
    })
  })

  describe('setCurrentToolUseId overwrite', () => {
    it('second setCurrentToolUseId overwrites the first', () => {
      // This documents a known limitation: if two PreToolUse hooks fire
      // before either tool handler calls consumeCurrentToolUseId, the
      // first ID is lost. The early-result buffering mitigates the
      // downstream impact, but the ID assignment itself is last-write-wins.
      inputManager.setCurrentToolUseId('hook-A')
      inputManager.setCurrentToolUseId('hook-B')

      expect(inputManager.consumeCurrentToolUseId()).toBe('hook-B')
      expect(inputManager.consumeCurrentToolUseId()).toBeNull()
    })
  })
})
