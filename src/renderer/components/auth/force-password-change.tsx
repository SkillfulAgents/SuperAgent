import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@renderer/lib/auth-client'
import { useChangePasswordSchema } from '@renderer/lib/password-utils'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Loader2 } from 'lucide-react'

type ChangePasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string }

export function ForcePasswordChange() {
  const [serverError, setServerError] = useState<string | null>(null)
  const { schema, placeholder } = useChangePasswordSchema()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: ChangePasswordValues) {
    setServerError(null)
    try {
      const res = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: true,
      })
      if (res.error) {
        setServerError(res.error.message || 'Password change failed')
        return
      }
      // The account.update.after hook auto-clears mustChangePassword.
      // Reload to fetch a fresh session with the updated flag.
      window.location.reload()
    } catch {
      setServerError('Password change failed. Please try again.')
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-2xl font-bold">Change Your Password</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Your account requires a password change before you can continue.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Temporary Password</Label>
              <Input
                id="current-password"
                type="password"
                placeholder="Enter your temporary password"
                autoComplete="current-password"
                autoFocus
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

            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
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
        </CardContent>
      </Card>
    </div>
  )
}
