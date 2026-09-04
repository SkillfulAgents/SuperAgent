import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { RequestError } from '@renderer/components/messages/request-error'
import { useUser } from '@renderer/context/user-context'
import { usePublicAuthConfig } from '@renderer/hooks/use-public-auth-config'
import { authClient } from '@renderer/lib/auth-client'
import { useChangePasswordSchema } from '@renderer/lib/password-utils'
import { cn } from '@shared/lib/utils'

// Shared with the Account tab's other sections so this card looks native there.
const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'
const VALUE_CLASS = 'text-xs text-muted-foreground truncate max-w-[260px]'
const FIELD_CLASS = 'h-8 text-xs w-full md:w-[260px]'

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
}

function SettingRow({ name, subtitle, right }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{name}</div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

interface FieldRowProps {
  id: string
  label: string
  /** Field-level validation message, shown under the control. */
  error?: string
  /** Server-side failure for this field's submit, shown under the validation message. */
  requestError?: string | null
  children: ReactNode
}

/**
 * A card row whose control is a text field: label left, field right, feedback
 * beneath. Stacks below `md` so the field keeps its width on narrow screens.
 */
function FieldRow({ id, label, error, requestError, children }: FieldRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
        <label htmlFor={id} className="min-w-0 flex-1 text-xs font-medium truncate block cursor-default">
          {label}
        </label>
        <div className="flex items-center gap-2 w-full md:w-auto">{children}</div>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      {requestError && (
        <div className="mt-2">
          <RequestError message={requestError} variant="compact" />
        </div>
      )}
    </div>
  )
}

// --- Name ---

const nameSchema = z.object({
  name: z.string().min(1, 'Name is required'),
})

type NameValues = z.infer<typeof nameSchema>

function NameRow({ currentName }: { currentName: string }) {
  const [requestError, setRequestError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: currentName },
  })

  async function onSubmit(data: NameValues) {
    setRequestError(null)
    try {
      const res = await authClient.updateUser({ name: data.name })
      if (res.error) {
        setRequestError(res.error.message || 'Failed to update name')
        return
      }
      // Re-baseline the form so Save disables again until the next edit.
      reset({ name: data.name })
      toast.success('Name updated')
    } catch {
      setRequestError('Failed to update name')
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <FieldRow id="profile-name" label="Name" error={errors.name?.message} requestError={requestError}>
        <Input
          id="profile-name"
          placeholder="Your name"
          className={cn(FIELD_CLASS, errors.name && 'border-destructive')}
          {...register('name')}
        />
        <Button type="submit" size="sm" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </Button>
      </FieldRow>
    </form>
  )
}

// --- Password ---

type ChangePasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string }

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [requestError, setRequestError] = useState<string | null>(null)
  const { schema, placeholder } = useChangePasswordSchema()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: ChangePasswordValues) {
    setRequestError(null)
    try {
      const res = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: false,
      })
      if (res.error) {
        setRequestError(res.error.message || 'Password change failed')
        return
      }
      toast.success('Password changed')
      onDone()
    } catch {
      setRequestError('Password change failed. Please try again.')
    }
  }

  return (
    // Rows inside the form keep the card's divider rhythm.
    <form onSubmit={handleSubmit(onSubmit)} className="divide-y divide-border/50">
      <FieldRow id="current-password" label="Current password" error={errors.currentPassword?.message}>
        <Input
          id="current-password"
          type="password"
          placeholder="Enter your current password"
          autoComplete="current-password"
          autoFocus
          className={cn(FIELD_CLASS, errors.currentPassword && 'border-destructive')}
          {...register('currentPassword')}
        />
      </FieldRow>
      <FieldRow id="new-password" label="New password" error={errors.newPassword?.message}>
        <Input
          id="new-password"
          type="password"
          placeholder={placeholder}
          autoComplete="new-password"
          className={cn(FIELD_CLASS, errors.newPassword && 'border-destructive')}
          {...register('newPassword')}
        />
      </FieldRow>
      <FieldRow id="confirm-password" label="Confirm new password" error={errors.confirmPassword?.message}>
        <Input
          id="confirm-password"
          type="password"
          placeholder="Re-enter your new password"
          autoComplete="new-password"
          className={cn(FIELD_CLASS, errors.confirmPassword && 'border-destructive')}
          {...register('confirmPassword')}
        />
      </FieldRow>
      <div className="py-3 px-4 space-y-2">
        <RequestError message={requestError} variant="compact" />
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Changing password…
              </>
            ) : (
              'Change password'
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}

/** Collapsed to a single row until the user asks to change their password. */
function PasswordRow() {
  const [open, setOpen] = useState(false)

  if (open) return <ChangePasswordForm onDone={() => setOpen(false)} />

  return (
    <SettingRow
      name="Password"
      right={
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Change password
        </Button>
      }
    />
  )
}

// --- Section ---

/**
 * The signed-in user's own profile — the top section of the Account tab in
 * auth mode. Email is read-only; name and password are edited in place.
 */
export function ProfileSection() {
  const { user } = useUser()
  const { config: authConfig, isLoading: authConfigLoading } = usePublicAuthConfig()
  // Email/password controls follow the effective local-auth setting. Platform-managed
  // deployments normally disable it, while migrated credential users remain manageable
  // whenever local auth is intentionally kept on.
  const showChangePassword =
    !authConfigLoading &&
    authConfig.allowLocalAuth

  return (
    <div className="space-y-2">
      <h3 className={SECTION_HEADING}>Profile & Login</h3>
      <div className={CARD_CLASS}>
        <SettingRow
          name="Email"
          right={<span className={VALUE_CLASS}>{user?.email ?? '—'}</span>}
        />
        {/* Keyed on the session's name so a refreshed session re-baselines the
            form instead of leaving a stale default in the field. */}
        <NameRow key={user?.name ?? ''} currentName={user?.name ?? ''} />
        {showChangePassword ? <PasswordRow /> : null}
      </div>
    </div>
  )
}
