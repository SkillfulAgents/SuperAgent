import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { authClient } from '@renderer/lib/auth-client'
import { useChangePasswordSchema } from '@renderer/lib/password-utils'
import { useUser } from '@renderer/context/user-context'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { PlatformConnectCard } from '@renderer/components/platform/platform-connect-card'
import { Loader2, Check } from 'lucide-react'

// --- Name form ---

const nameSchema = z.object({
  name: z.string().min(1, 'Name is required'),
})

type NameValues = z.infer<typeof nameSchema>

function ProfileSection() {
  const { user } = useUser()
  const [nameStatus, setNameStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: user?.name ?? '' },
  })

  async function onSubmitName(data: NameValues) {
    setNameStatus(null)
    try {
      const res = await authClient.updateUser({ name: data.name })
      if (res.error) {
        setNameStatus({ type: 'error', message: res.error.message || 'Failed to update name' })
        return
      }
      setNameStatus({ type: 'success', message: 'Name updated' })
    } catch {
      setNameStatus({ type: 'error', message: 'Failed to update name' })
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="profile-email">Email</Label>
        <Input id="profile-email" value={user?.email ?? ''} disabled className="bg-muted" />
      </div>

      <form onSubmit={handleSubmit(onSubmitName)} className="space-y-2">
        <Label htmlFor="profile-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="profile-name"
            placeholder="Your name"
            className={errors.name ? 'border-destructive' : ''}
            {...register('name')}
          />
          <Button type="submit" size="sm" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'Save'
            )}
          </Button>
        </div>
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        {nameStatus?.type === 'success' && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            {nameStatus.message}
          </p>
        )}
        {nameStatus?.type === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{nameStatus.message}</AlertDescription>
          </Alert>
        )}
      </form>
    </div>
  )
}

// --- Password form ---

type ChangePasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string }

function ChangePasswordSection() {
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const { schema, placeholder } = useChangePasswordSchema()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: ChangePasswordValues) {
    setStatus(null)
    try {
      const res = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: false,
      })
      if (res.error) {
        setStatus({ type: 'error', message: res.error.message || 'Password change failed' })
        return
      }
      setStatus({ type: 'success', message: 'Password changed successfully' })
      reset()
    } catch {
      setStatus({ type: 'error', message: 'Password change failed. Please try again.' })
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current-password">Current Password</Label>
        <Input
          id="current-password"
          type="password"
          placeholder="Enter your current password"
          autoComplete="current-password"
          className={errors.currentPassword ? 'border-destructive' : ''}
          {...register('currentPassword')}
        />
        {errors.currentPassword && (
          <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">New Password</Label>
        <Input
          id="new-password"
          type="password"
          placeholder={placeholder}
          autoComplete="new-password"
          className={errors.newPassword ? 'border-destructive' : ''}
          {...register('newPassword')}
        />
        {errors.newPassword && (
          <p className="text-xs text-destructive">{errors.newPassword.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm New Password</Label>
        <Input
          id="confirm-password"
          type="password"
          placeholder="Re-enter your new password"
          autoComplete="new-password"
          className={errors.confirmPassword ? 'border-destructive' : ''}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
        )}
      </div>

      {status?.type === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}
      {status?.type === 'success' && (
        <p className="text-xs text-green-600 flex items-center gap-1">
          <Check className="h-3 w-3" />
          {status.message}
        </p>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Changing password...
          </>
        ) : (
          'Change Password'
        )}
      </Button>
    </form>
  )
}

// --- Main tab ---

export function ProfileTab() {
  return (
    <div className="space-y-6">
      <ProfileSection />

      <div className="pt-4 border-t space-y-4">
        <div className="space-y-1">
          <Label className="text-base">Datawizz Platform</Label>
          <p className="text-sm text-muted-foreground">
            Manage the platform account and local token tied to your SuperAgent login.
          </p>
        </div>
        <PlatformConnectCard />
      </div>

      <div className="pt-4 border-t space-y-4">
        <Label className="text-base">Change Password</Label>
        <ChangePasswordSection />
      </div>
    </div>
  )
}
