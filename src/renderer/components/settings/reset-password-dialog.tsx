import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Loader2, Copy, Check } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'

function generateTempPassword(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
}

interface ResetPasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: string; name: string; email: string } | null
  onReset: () => void
}

export function ResetPasswordDialog({ open, onOpenChange, user, onReset }: ResetPasswordDialogProps) {
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  function resetState() {
    setTempPassword(null)
    setCopied(false)
    setServerError(null)
    setIsSubmitting(false)
  }

  function handleClose() {
    resetState()
    onOpenChange(false)
  }

  async function handleReset() {
    if (!user) return
    setServerError(null)
    setIsSubmitting(true)
    const password = generateTempPassword()

    try {
      const res = await apiFetch('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, password }),
      })

      if (!res.ok) {
        const err = await res.json()
        setServerError(err.error || 'Failed to reset password')
        return
      }

      setTempPassword(password)
      onReset()
    } catch {
      setServerError('Failed to reset password')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCopy() {
    if (tempPassword) {
      await navigator.clipboard.writeText(tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tempPassword ? 'Password Reset' : 'Reset Password'}</DialogTitle>
          <DialogDescription>
            {tempPassword
              ? 'Share the temporary password with the user.'
              : `Reset the password for ${user?.name} (${user?.email})?`}
          </DialogDescription>
        </DialogHeader>

        {tempPassword ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Temporary Password</Label>
              <div className="flex gap-2">
                <Input value={tempPassword} readOnly className="font-mono" />
                <Button variant="outline" size="icon" onClick={handleCopy} title="Copy password">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The user will be prompted to change this password on next login.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This will generate a new temporary password and require the user to change it on their
              next login.
            </p>

            {serverError && (
              <Alert variant="destructive">
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleReset} disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  'Reset Password'
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
