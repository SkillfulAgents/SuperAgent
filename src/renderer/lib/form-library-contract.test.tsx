// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const nameSchema = z.object({ name: z.string().min(1, 'Name is required') })
type NameValues = z.infer<typeof nameSchema>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(cleanup)

// These exercise the installed library's async resolver guarantees using the
// same primitives as our forms. They are hardening contracts: current app
// schemas do not deliberately throw or wait for an external validation service.
describe('async form resolver contracts', () => {
  it('clears submitting state when validation rejects and permits a fresh submission', async () => {
    const validation = deferred<void>()
    const realResolver = zodResolver(nameSchema)
    let first = true
    const resolver: Resolver<NameValues> = async (...args) => {
      if (first) { first = false; await validation.promise }
      return realResolver(...args)
    }
    const { result } = renderHook(() => {
      const form = useForm<NameValues>({ resolver, defaultValues: { name: 'Ada' } })
      return { form, isSubmitting: form.formState.isSubmitting }
    })
    const saved = vi.fn()
    const failed = new Error('Validation service unavailable')
    let submission!: Promise<void>
    act(() => { submission = result.current.form.handleSubmit(saved)() })
    expect(result.current.isSubmitting).toBe(true)
    await act(async () => {
      const rejection = expect(submission).rejects.toBe(failed)
      validation.reject(failed)
      await rejection
    })
    expect(result.current.isSubmitting).toBe(false)
    expect(saved).not.toHaveBeenCalled()
    await act(async () => { await result.current.form.handleSubmit(saved)() })
    expect(saved).toHaveBeenCalledOnce()
    expect(saved.mock.calls[0][0]).toEqual({ name: 'Ada' })
    expect(result.current.isSubmitting).toBe(false)
  })

  it('does not apply an obsolete async validation error after reset establishes a new baseline', async () => {
    const validation = deferred<void>()
    const realResolver = zodResolver(nameSchema)
    let first = true
    const resolver: Resolver<NameValues> = async (...args) => {
      // Capture the real validation result before waiting; the caller may reset
      // while it is pending, just as an asynchronous refinement could finish late.
      const validated = await realResolver(...args)
      if (first) { first = false; await validation.promise }
      return validated
    }
    const { result } = renderHook(() => {
      const form = useForm<NameValues>({ resolver, defaultValues: { name: '' } })
      return { form, errors: form.formState.errors, isDirty: form.formState.isDirty, isSubmitting: form.formState.isSubmitting }
    })
    const saved = vi.fn()
    let submission!: Promise<void>
    await act(async () => { submission = result.current.form.handleSubmit(saved)(); await Promise.resolve() })
    expect(result.current.isSubmitting).toBe(true)
    act(() => { result.current.form.reset({ name: 'Updated profile' }) })
    await act(async () => { validation.resolve(); await submission })
    expect(result.current.form.getValues()).toEqual({ name: 'Updated profile' })
    expect(result.current.errors).toEqual({})
    expect(result.current.isDirty).toBe(false)
    expect(result.current.isSubmitting).toBe(false)
    expect(saved).not.toHaveBeenCalled()
    await act(async () => { await result.current.form.handleSubmit(saved)() })
    expect(saved).toHaveBeenCalledOnce()
    expect(saved.mock.calls[0][0]).toEqual({ name: 'Updated profile' })
  })
})
