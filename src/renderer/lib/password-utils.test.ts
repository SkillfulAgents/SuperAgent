// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { makeChangePasswordSchema } from './password-utils'

describe('makeChangePasswordSchema', () => {
  describe('without complexity requirements', () => {
    const schema = makeChangePasswordSchema(8, false)

    it('accepts valid input', () => {
      const result = schema.safeParse({
        currentPassword: 'oldpass',
        newPassword: 'newpassword',
        confirmPassword: 'newpassword',
      })
      expect(result.success).toBe(true)
    })

    it('rejects when new password is too short', () => {
      const result = schema.safeParse({
        currentPassword: 'oldpass',
        newPassword: 'short',
        confirmPassword: 'short',
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toContain('at least 8 characters')
    })

    it('rejects when passwords do not match', () => {
      const result = schema.safeParse({
        currentPassword: 'oldpass',
        newPassword: 'newpassword',
        confirmPassword: 'different',
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues.some((i) => i.message === 'Passwords do not match')).toBe(true)
    })

    it('rejects when new password equals current password', () => {
      const result = schema.safeParse({
        currentPassword: 'samepassword',
        newPassword: 'samepassword',
        confirmPassword: 'samepassword',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) =>
          i.message === 'New password must be different from current password'
        )
      ).toBe(true)
    })

    it('rejects when current password is empty', () => {
      const result = schema.safeParse({
        currentPassword: '',
        newPassword: 'newpassword',
        confirmPassword: 'newpassword',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) => i.message === 'Current password is required')
      ).toBe(true)
    })

    it('accepts passwords without uppercase/numbers/symbols', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'alllowercase',
        confirmPassword: 'alllowercase',
      })
      expect(result.success).toBe(true)
    })
  })

  describe('with complexity requirements', () => {
    const schema = makeChangePasswordSchema(12, true)

    it('accepts fully compliant password', () => {
      const result = schema.safeParse({
        currentPassword: 'oldpass',
        newPassword: 'MyPassword1!',
        confirmPassword: 'MyPassword1!',
      })
      expect(result.success).toBe(true)
    })

    it('rejects password missing lowercase', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'MYPASSWORD1!',
        confirmPassword: 'MYPASSWORD1!',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) => i.message === 'Must contain a lowercase letter')
      ).toBe(true)
    })

    it('rejects password missing uppercase', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'mypassword1!',
        confirmPassword: 'mypassword1!',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) => i.message === 'Must contain an uppercase letter')
      ).toBe(true)
    })

    it('rejects password missing number', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'MyPasswordAB!',
        confirmPassword: 'MyPasswordAB!',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) => i.message === 'Must contain a number')
      ).toBe(true)
    })

    it('rejects password missing symbol', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'MyPassword12',
        confirmPassword: 'MyPassword12',
      })
      expect(result.success).toBe(false)
      expect(
        result.error?.issues.some((i) => i.message === 'Must contain a symbol')
      ).toBe(true)
    })

    it('enforces minimum length alongside complexity', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'Ab1!',
        confirmPassword: 'Ab1!',
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toContain('at least 12 characters')
    })

    it('reports multiple violations at once', () => {
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'abcdefghijkl', // lowercase only, 12 chars
        confirmPassword: 'abcdefghijkl',
      })
      expect(result.success).toBe(false)
      const messages = result.error?.issues.map((i) => i.message) || []
      expect(messages).toContain('Must contain an uppercase letter')
      expect(messages).toContain('Must contain a number')
      expect(messages).toContain('Must contain a symbol')
    })
  })

  describe('configurable min length', () => {
    it('uses the provided min length', () => {
      const schema = makeChangePasswordSchema(20, false)
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'abcdefghijklmno', // 15 chars
        confirmPassword: 'abcdefghijklmno',
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toContain('at least 20 characters')
    })

    it('accepts password at exact min length', () => {
      const schema = makeChangePasswordSchema(5, false)
      const result = schema.safeParse({
        currentPassword: 'old',
        newPassword: 'abcde',
        confirmPassword: 'abcde',
      })
      expect(result.success).toBe(true)
    })
  })
})
