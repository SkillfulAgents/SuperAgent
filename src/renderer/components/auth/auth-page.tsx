import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { signIn, signUp } from '@renderer/lib/auth-client'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Loader2 } from 'lucide-react'

// --- Schemas ---

const signInSchema = z.object({
  email: z.email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

const signUpSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    email: z.email('Please enter a valid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type SignInValues = z.infer<typeof signInSchema>
type SignUpValues = z.infer<typeof signUpSchema>

// --- Components ---

function SignInForm({ onSwitchToSignUp }: { onSwitchToSignUp: () => void }) {
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

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <button type="button" onClick={onSwitchToSignUp} className="text-primary underline">
          Sign up
        </button>
      </p>
    </form>
  )
}

function SignUpForm({ onSwitchToSignIn }: { onSwitchToSignIn: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
  })

  async function onSubmit(data: SignUpValues) {
    setServerError(null)
    try {
      const res = await signUp.email({
        name: data.name,
        email: data.email,
        password: data.password,
      })
      if (res.error) {
        setServerError(res.error.message || 'Sign up failed')
      }
    } catch {
      setServerError('Sign up failed. Please try again.')
    }
  }

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
          placeholder="At least 8 characters"
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
  const [tab, setTab] = useState<string>('signin')

  return (
    <div className="flex items-center justify-center h-screen bg-background" data-testid="auth-page">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h1 className="text-2xl font-bold">SuperAgent</h1>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full mb-4">
              <TabsTrigger value="signin" className="flex-1" data-testid="auth-tab-signin">Sign In</TabsTrigger>
              <TabsTrigger value="signup" className="flex-1" data-testid="auth-tab-signup">Sign Up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <SignInForm onSwitchToSignUp={() => setTab('signup')} />
            </TabsContent>
            <TabsContent value="signup">
              <SignUpForm onSwitchToSignIn={() => setTab('signin')} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
