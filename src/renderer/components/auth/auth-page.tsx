import { useState, useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { signIn, signUp, signOut } from '@renderer/lib/auth-client'
import { apiFetch } from '@renderer/lib/api'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Loader2 } from 'lucide-react'

// --- Public auth config (fetched from server) ---

interface AuthConfig {
  signupMode: string
  allowLocalAuth: boolean
  allowSocialAuth: boolean
  passwordMinLength: number
  passwordRequireComplexity: boolean
  requireAdminApproval: boolean
  hasUsers: boolean
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  signupMode: 'open',
  allowLocalAuth: true,
  allowSocialAuth: false,
  passwordMinLength: 8,
  passwordRequireComplexity: false,
  requireAdminApproval: false,
  hasUsers: false,
}

function useAuthConfig() {
  const [config, setConfig] = useState<AuthConfig>(DEFAULT_AUTH_CONFIG)

  useEffect(() => {
    apiFetch('/api/auth-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setConfig(data) })
      .catch(() => {})
  }, [])

  return config
}

// --- Schemas ---

const signInSchema = z.object({
  email: z.email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

function makeSignUpSchema(minLength: number, requireComplexity: boolean) {
  let passwordSchema = z.string().min(minLength, `Password must be at least ${minLength} characters`)
  if (requireComplexity) {
    passwordSchema = passwordSchema
      .refine((p) => /[a-z]/.test(p), 'Must contain a lowercase letter')
      .refine((p) => /[A-Z]/.test(p), 'Must contain an uppercase letter')
      .refine((p) => /[0-9]/.test(p), 'Must contain a number')
      .refine((p) => /[^a-zA-Z0-9]/.test(p), 'Must contain a symbol') as unknown as z.ZodString
  }

  return z
    .object({
      name: z.string().min(1, 'Name is required'),
      email: z.email('Please enter a valid email address'),
      password: passwordSchema,
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    })
}

type SignInValues = z.infer<typeof signInSchema>
type SignUpValues = { name: string; email: string; password: string; confirmPassword: string }

// --- Components ---

function SignInForm({ onSwitchToSignUp, showSignupLink }: { onSwitchToSignUp: () => void; showSignupLink: boolean }) {
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
  })

  async function onSubmit(data: SignInValues) {
    setServerError(null)
    try {
      const res = await signIn.email({ email: data.email, password: data.password })
      if (res.error) {
        setServerError(res.error.message || 'Sign in failed')
      }
    } catch {
      setServerError('Sign in failed. Please try again.')
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus
          className={errors.email ? 'border-destructive' : ''}
          {...register('email')}
        />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signin-password">Password</Label>
        <Input
          id="signin-password"
          type="password"
          placeholder="Enter your password"
          autoComplete="current-password"
          className={errors.password ? 'border-destructive' : ''}
          {...register('password')}
        />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>

      {serverError && (
        <Alert variant="destructive" data-testid="signin-error">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={isSubmitting} data-testid="signin-submit">
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Signing in...
          </>
        ) : (
          'Sign in'
        )}
      </Button>

      {showSignupLink && (
        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{' '}
          <button type="button" onClick={onSwitchToSignUp} className="text-primary underline">
            Sign up
          </button>
        </p>
      )}
    </form>
  )
}

function SignUpForm({ onSwitchToSignIn, config }: { onSwitchToSignIn: () => void; config: AuthConfig }) {
  const [serverError, setServerError] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState(false)

  const schema = useMemo(
    () => makeSignUpSchema(config.passwordMinLength, config.passwordRequireComplexity),
    [config.passwordMinLength, config.passwordRequireComplexity]
  )

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: SignUpValues) {
    setServerError(null)
    setPendingApproval(false)
    try {
      const res = await signUp.email({
        name: data.name,
        email: data.email,
        password: data.password,
      })
      if (res.error) {
        const msg = res.error.message || 'Sign up failed'
        // Better Auth returns a specific error when user is banned
        if (msg.toLowerCase().includes('banned') || msg.toLowerCase().includes('suspended')) {
          setPendingApproval(true)
        } else {
          setServerError(msg)
        }
      } else if (config.requireAdminApproval && config.hasUsers) {
        // Signup succeeded but user is auto-banned pending admin review.
        // Sign out the auto-created session so AuthGate keeps showing the
        // auth page instead of navigating to the main app.
        try { await signOut() } catch { /* session cleanup is best-effort */ }
        setPendingApproval(true)
      }
    } catch {
      setServerError('Sign up failed. Please try again.')
    }
  }

  if (pendingApproval) {
    return (
      <div className="text-center space-y-3 py-4" data-testid="pending-approval">
        <h3 className="font-medium">Account Pending Approval</h3>
        <p className="text-sm text-muted-foreground">
          Your account has been created but requires admin approval before you can sign in.
          You will be notified when your account is activated.
        </p>
        <Button variant="outline" onClick={() => { setPendingApproval(false); onSwitchToSignIn() }}>
          Back to Sign In
        </Button>
      </div>
    )
  }

  const passwordPlaceholder = config.passwordRequireComplexity
    ? `At least ${config.passwordMinLength} chars, mixed case + number + symbol`
    : `At least ${config.passwordMinLength} characters`

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="signup-name">Name</Label>
        <Input
          id="signup-name"
          type="text"
          placeholder="Your name"
          autoComplete="name"
          autoFocus
          className={errors.name ? 'border-destructive' : ''}
          {...register('name')}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-email">Email</Label>
        <Input
          id="signup-email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          className={errors.email ? 'border-destructive' : ''}
          {...register('email')}
        />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-password">Password</Label>
        <Input
          id="signup-password"
          type="password"
          placeholder={passwordPlaceholder}
          autoComplete="new-password"
          className={errors.password ? 'border-destructive' : ''}
          {...register('password')}
        />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-confirm">Confirm Password</Label>
        <Input
          id="signup-confirm"
          type="password"
          placeholder="Re-enter your password"
          autoComplete="new-password"
          className={errors.confirmPassword ? 'border-destructive' : ''}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>}
      </div>

      {serverError && (
        <Alert variant="destructive" data-testid="signup-error">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={isSubmitting} data-testid="signup-submit">
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Creating account...
          </>
        ) : (
          'Sign up'
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <button type="button" onClick={onSwitchToSignIn} className="text-primary underline">
          Sign in
        </button>
      </p>
    </form>
  )
}

export function AuthPage() {
  const config = useAuthConfig()
  const [tab, setTab] = useState<string>('signin')

  // Signup is allowed in 'open' or 'domain_restricted' modes, OR for the very first user
  const signupAllowed = !config.hasUsers || config.signupMode === 'open' || config.signupMode === 'domain_restricted'

  return (
    <div className="flex items-center justify-center h-screen bg-background" data-testid="auth-page">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-2xl font-bold">SuperAgent</h1>
        </CardHeader>
        <CardContent>
          {signupAllowed ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full mb-4">
                <TabsTrigger value="signin" className="flex-1" data-testid="auth-tab-signin">Sign In</TabsTrigger>
                <TabsTrigger value="signup" className="flex-1" data-testid="auth-tab-signup">Sign Up</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                <SignInForm onSwitchToSignUp={() => setTab('signup')} showSignupLink={true} />
              </TabsContent>
              <TabsContent value="signup">
                <SignUpForm onSwitchToSignIn={() => setTab('signin')} config={config} />
              </TabsContent>
            </Tabs>
          ) : (
            <SignInForm onSwitchToSignUp={() => {}} showSignupLink={false} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
