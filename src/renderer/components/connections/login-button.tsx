import { useCallback, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { LoginWindowCancel } from './login-window-cancel'

export type LoginButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    icon?: ReactNode
    label?: ReactNode
    /** Replaces `label` while pending. Falls back to `label`. */
    pendingLabel?: ReactNode
    pending: boolean
    canCancel: boolean
    onCancel: () => void
    /**
     * Where the Cancel link sits: the side that keeps the button itself from
     * moving. `'none'` renders the Button alone and leaves Cancel to the caller.
     */
    cancelSide: 'left' | 'right' | 'none'
  }

/**
 * Cancel unmounts its own link, so focus would fall to the page. Call `arm`
 * from the Cancel handler; focus moves to `targetRef` once `busy` clears.
 */
export function useFocusAfterCancel<T extends HTMLElement>(busy: boolean) {
  const targetRef = useRef<T>(null)
  const armedRef = useRef(false)
  useEffect(() => {
    if (busy || !armedRef.current) return
    armedRef.current = false
    targetRef.current?.focus()
  }, [busy])
  const arm = useCallback(() => {
    armedRef.current = true
  }, [])
  return { targetRef, arm }
}

/**
 * The button that opens a login window. Presentational: the caller owns the
 * window (`useLoginWindow` or a hook built on it) and passes its state here.
 * While pending the icon becomes the spinner, the label becomes `pendingLabel`,
 * and the button is disabled. Cancel appears beside it once `canCancel` is true.
 */
export function LoginButton({
  icon,
  label,
  pendingLabel,
  pending,
  canCancel,
  onCancel,
  cancelSide,
  disabled,
  ...props
}: LoginButtonProps) {
  // Back to the button once it is enabled again.
  const { targetRef: buttonRef, arm: focusAfterCancel } = useFocusAfterCancel<HTMLButtonElement>(pending || !!disabled)

  const button = (
    <Button
      ref={buttonRef}
      icon={icon}
      loading={pending}
      disabled={disabled}
      {...props}
    >
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  )
  const status = (
    <span role="status" className="sr-only">
      {pending && (pendingLabel ?? label)}
      {pending && canCancel && ', Cancel available'}
    </span>
  )

  if (cancelSide === 'none') {
    return (
      <>
        {button}
        {status}
      </>
    )
  }

  const cancel = (
    <LoginWindowCancel
      visible={canCancel}
      onCancel={() => {
        focusAfterCancel()
        onCancel()
      }}
    />
  )
  return (
    <span className="inline-flex items-center gap-2">
      {cancelSide === 'left' && cancel}
      {button}
      {cancelSide === 'right' && cancel}
      {status}
    </span>
  )
}
