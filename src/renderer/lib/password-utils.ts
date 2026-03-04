import { useState, useEffect, useMemo } from 'react'
import { z } from 'zod'
import { apiFetch } from '@renderer/lib/api'

export interface PasswordPolicy {
  passwordMinLength: number
  passwordRequireComplexity: boolean
}

export function usePasswordPolicy(): PasswordPolicy {
  const [policy, setPolicy] = useState<PasswordPolicy>({
    passwordMinLength: 12,
    passwordRequireComplexity: true,
  })

  useEffect(() => {
    apiFetch('/api/auth-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setPolicy({
            passwordMinLength: data.passwordMinLength ?? 12,
            passwordRequireComplexity: data.passwordRequireComplexity ?? true,
          })
        }
      })
      .catch(() => {})
  }, [])

  return policy
}

export function makeChangePasswordSchema(minLength: number, requireComplexity: boolean) {
  let newPasswordSchema = z.string().min(minLength, `Password must be at least ${minLength} characters`)
  if (requireComplexity) {
    newPasswordSchema = newPasswordSchema
      .refine((p) => /[a-z]/.test(p), 'Must contain a lowercase letter')
      .refine((p) => /[A-Z]/.test(p), 'Must contain an uppercase letter')
      .refine((p) => /[0-9]/.test(p), 'Must contain a number')
      .refine((p) => /[^a-zA-Z0-9]/.test(p), 'Must contain a symbol') as unknown as z.ZodString
  }

  return z
    .object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: newPasswordSchema,
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
      message: 'New password must be different from current password',
      path: ['newPassword'],
    })
}

export function useChangePasswordSchema() {
  const policy = usePasswordPolicy()
  const schema = useMemo(
    () => makeChangePasswordSchema(policy.passwordMinLength, policy.passwordRequireComplexity),
    [policy.passwordMinLength, policy.passwordRequireComplexity]
  )
  const placeholder = policy.passwordRequireComplexity
    ? `At least ${policy.passwordMinLength} chars, mixed case + number + symbol`
    : `At least ${policy.passwordMinLength} characters`
  return { schema, placeholder }
}
