import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { Eye, EyeOff, Lock, LockOpen, MousePointerClick } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from '../requests/decline-button'
import { BrowserCredentialPicker } from '../request-browser-input/browser-credential-picker'
import {
  compactLoginCode,
  isInsecureOrigin,
  loginFillResultSchema,
  siteLabel,
  type LoginContext,
  type LoginContextField,
  type LoginFieldKind,
  type LoginFieldSummary,
} from './login-request'
import { loginRequestKey, recallLoginValues, setLoginRequestState } from './login-request-store'
import { LoginContextUnavailable, useLoginContext, useLoginRequestActions } from './use-login-request'

interface LoginFormProps {
  agentSlug: string
  sessionId: string
  toolUseId: string
  /** The agent's fields, drawn (disabled) until the browser has located them. */
  fields: LoginFieldSummary[]
  autoFocus?: boolean
}

/** What each kind is, in the app's words: the page's label is the agent's to choose. */
const KIND_CHIPS: Record<LoginFieldKind, string> = {
  username: 'username',
  password: 'password',
  otp: 'code',
  text: 'other',
}

/**
 * Keeps password managers from filing what is typed here under this app's
 * origin — these are another site's credentials, and the app's origin hosts
 * every site's form. Saved logins come from the host's password manager.
 */
const NOT_FOR_PASSWORD_MANAGERS = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  'data-lpignore': 'true',
} as const

/** Input attributes for a field: the keyboard, and what the OS may offer. */
function inputAttributes(field: Pick<LoginContextField, 'kind' | 'inputType' | 'inputMode'>): ComponentProps<'input'> {
  switch (field.kind) {
    case 'username': {
      // Plain text: an "email or phone" field must take a phone number, so no
      // native email validation — the email keyboard is enough.
      const inputMode = field.inputType === 'email' ? 'email' : field.inputType === 'tel' ? 'tel' : undefined
      return { type: 'text', inputMode, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, ...NOT_FOR_PASSWORD_MANAGERS }
    }
    case 'otp': {
      const numeric = field.inputMode === 'numeric' || field.inputType === 'tel' || field.inputType === 'number'
      // one-time-code lets iOS and Android offer the code from an SMS.
      return { type: 'text', inputMode: numeric ? 'numeric' : 'text', autoComplete: 'one-time-code', autoCorrect: 'off', spellCheck: false }
    }
    default:
      return { type: 'text', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false, ...NOT_FOR_PASSWORD_MANAGERS }
  }
}

/**
 * A masked input. In the desktop app it is a password input: Electron has no
 * password manager, and a password input stays masked to screen readers, OS
 * accessibility and keyboards too. In a browser it is a text input masked
 * on screen only — a password input there would be offered the app's own
 * saved password, which is not for this site.
 */
function SecretInput({ className, label, ...props }: ComponentProps<typeof Input> & { label: string }) {
  const [show, setShow] = useState(false)
  const passwordInput = isElectron()
  return (
    <div className="relative">
      <Input
        {...props}
        type={passwordInput && !show ? 'password' : 'text'}
        className={cn('pr-10', !passwordInput && !show && '[-webkit-text-security:disc]', className)}
      />
      <button
        type="button"
        onClick={() => setShow((value) => !value)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={`Show ${label}`}
        aria-pressed={show}
        disabled={props.disabled}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

/** What the agent can see of the values, said exactly. */
function privacyNote(site: string, kinds: LoginFieldKind[]): string {
  const hidden = [
    kinds.includes('password') && 'password',
    kinds.includes('otp') && 'code',
    kinds.includes('text') && 'other fields',
  ].filter(Boolean) as string[]
  const list = hidden.length > 1 ? `${hidden.slice(0, -1).join(', ')} or ${hidden[hidden.length - 1]}` : hidden[0]
  if (!kinds.includes('username')) return `What you enter goes straight into ${site}. The agent never sees it.`
  if (!hidden.length) return `What you enter goes straight into ${site}. The agent can see the username.`
  return `What you enter goes straight into ${site}. The agent never sees the ${list}; it can see the username.`
}

/**
 * The site the values go to, as the browser reported it. The card's title
 * already names the host, so only the full origin is added. Hosts wrap rather
 * than truncate: the end of a hostname is the part that names the site.
 */
export function LoginSiteHeading({ context, className }: { context: Pick<LoginContext, 'origin' | 'topOrigin'> | null; className?: string }) {
  const origin = context?.origin ?? null
  const insecure = origin !== null && isInsecureOrigin(origin)
  const Icon = insecure ? LockOpen : Lock
  const framed = context && context.topOrigin !== context.origin
  return (
    <div className={cn('flex items-start gap-1.5 min-w-0 text-xs text-muted-foreground', className)} data-testid="login-site">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', insecure && 'text-amber-600')} />
      {origin ? (
        <div className="min-w-0 break-all">
          <span data-testid="login-origin">{origin}</span>
          {insecure && <span className="block text-amber-700 dark:text-amber-400" data-testid="login-insecure">Not encrypted (http): what you enter can be read on the network.</span>}
          {framed && <span className="block" data-testid="login-framed">In a frame on {siteLabel(context.topOrigin)}</span>}
        </div>
      ) : (
        <span>Locating the sign-in form on the page…</span>
      )}
    </div>
  )
}

export function LoginForm({
  agentSlug,
  sessionId,
  toolUseId,
  fields: summaryFields,
  autoFocus = false,
}: LoginFormProps) {
  const formId = useId()
  const errorId = `${formId}-error`
  const context = useLoginContext(agentSlug, sessionId, toolUseId)
  const { state, fill, completeManually, decline } = useLoginRequestActions({ agentSlug, sessionId, toolUseId })
  const [mode, setMode] = useState<'form' | 'manual'>('form')
  const [values, setValues] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const located: LoginContext | undefined = context.data
  // Prefill the identifier from this window's memory of the last attempt.
  useEffect(() => {
    if (!located) return
    setValues((current) => current.some(Boolean) ? current : recallLoginValues(agentSlug, sessionId, located.origin, located.fields))
  }, [agentSlug, sessionId, located])
  // Focus once the fields are usable: they mount disabled, and autoFocus only
  // applies on mount. The browser can take a while to locate them, so only
  // when focus is nowhere else — never pull it from the composer mid-sentence.
  useEffect(() => {
    if (!autoFocus || !located) return
    const active = document.activeElement
    if (!active || active === document.body || rootRef.current?.contains(active)) firstFieldRef.current?.focus()
  }, [autoFocus, located])

  const busy = state.status === 'submitting'
  const running = state.status === 'submitting' ? state.action : null
  const fields: Array<LoginFieldSummary & Partial<LoginContextField>> = located?.fields ?? summaryFields
  const secret = fields.some((field) => field.kind === 'password' || field.kind === 'otp')
  const complete = located !== undefined && located.fields.every((_, index) => (values[index] ?? '').length > 0)
  const unavailable = context.error instanceof LoginContextUnavailable ? context.error : null
  const stillLocating = !located && !unavailable && context.failureCount > 1
  const error = state.status === 'idle' ? state.error : undefined
  // A saved login holds an identifier and a password: offered only when that
  // is all the page asks for. It goes straight into the page, never the form.
  const savedLoginFits = located !== undefined && located.fields.every((field) => field.kind === 'username' || field.kind === 'password')

  const submit = () => {
    if (!located || !complete || busy) return
    void fill(located, located.fields.map((_, index) => values[index] ?? ''))
  }

  if (mode === 'manual') {
    return (
      <div ref={rootRef} className="space-y-3 pt-4" data-testid="login-manual">
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
          <MousePointerClick className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Sign in directly in the browser view{located ? ` on ${siteLabel(located.origin)}` : ''}, then click Done.
            {' '}What you type on the page itself is not hidden from the agent.
          </span>
        </div>
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={() => setMode('form')} disabled={busy} data-testid="login-back-to-form">
            Back to the form
          </Button>
          <Button
            size="xs"
            className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => void completeManually()}
            loading={running === 'manual'}
            disabled={busy}
            data-testid="login-manual-done"
          >
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="space-y-3 pt-4">
      <LoginSiteHeading context={located ?? null} />

      {/* Only the fields sit inside the <form>: the picker and Decline render
          plain <button>s, and inside it the first would be the default button
          Enter presses. */}
      {savedLoginFits && (
        <BrowserCredentialPicker
          agentSlug={agentSlug}
          sessionId={sessionId}
          toolUseId={toolUseId}
          kind="login"
          disabled={busy}
          onFilled={(body) => {
            const key = loginRequestKey(agentSlug, sessionId, toolUseId)
            // Answered in another window first: nothing was filled from here.
            if ((body as { alreadySettled?: unknown } | null)?.alreadySettled === true) {
              setLoginRequestState(key, { status: 'settled' })
              return
            }
            const parsed = loginFillResultSchema.safeParse(body)
            setLoginRequestState(key, parsed.success
              ? { status: 'filled', result: parsed.data }
              : { status: 'idle', error: 'The saved login was sent, but the answer could not be read. Check the browser view.' })
          }}
        />
      )}

      <form
        id={formId}
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        data-testid="login-form"
      >
        {unavailable ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground" data-testid="login-unavailable">
            <p>The fields the agent picked could not be used, so nothing will be sent from this form.</p>
            {unavailable.problems.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {unavailable.problems.map((problem, index) => <li key={index}>{problem}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {fields.map((field, index) => {
              const inputId = `${formId}-field-${index}`
              const attributes = inputAttributes({ kind: field.kind, inputType: field.inputType ?? '', inputMode: field.inputMode ?? '' })
              const common = {
                ...attributes,
                id: inputId,
                ref: index === 0 ? firstFieldRef : undefined,
                name: `${field.kind}-${index}`,
                value: values[index] ?? '',
                disabled: !located || busy,
                // A code's limit applies once its separators are gone: a pasted
                // "123 456" would otherwise lose its last digit to a limit of 6.
                maxLength: field.kind !== 'otp' && field.maxLength && field.maxLength > 1 ? field.maxLength : undefined,
                'aria-describedby': error ? errorId : undefined,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  const typed = event.target.value
                  const next = field.kind === 'otp'
                    ? compactLoginCode(typed, { inputType: field.inputType ?? '', inputMode: field.inputMode ?? '', maxLength: field.maxLength ?? -1 })
                    : typed
                  setValues((current) => {
                    const copy = [...current]
                    copy[index] = next
                    return copy
                  })
                },
                className: 'bg-background',
                'data-testid': `login-field-${index}`,
                'data-kind': field.kind,
              }
              return (
                <div key={index} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={inputId} className="block min-w-0 truncate text-xs font-medium text-foreground">{field.label}</label>
                    <span className="shrink-0 text-2xs text-muted-foreground" data-testid={`login-field-kind-${index}`}>{KIND_CHIPS[field.kind]}</span>
                  </div>
                  {field.kind === 'password' || field.kind === 'text' ? <SecretInput {...common} label={field.label} /> : <Input {...common} />}
                </div>
              )
            })}
          </div>
        )}

        {stillLocating && (
          <p className="text-xs text-muted-foreground" data-testid="login-still-locating">
            Still waiting for the browser to locate the form…
            {' '}
            <button type="button" className="underline" onClick={() => void context.refetch()}>Try again</button>
          </p>
        )}

        {error && <p id={errorId} className="text-xs text-destructive" role="alert" data-testid="login-error">{error}</p>}

        {located && !unavailable && (
          <p className="text-2xs text-muted-foreground" data-testid="login-privacy">
            {privacyNote(siteLabel(located.origin), located.fields.map((field) => field.kind))}
          </p>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Not for this app's own page: typing the app's password there by hand
            would sign the agent's browser in to it. */}
        {unavailable?.forThisApp ? <span /> : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs text-muted-foreground"
            onClick={() => setMode('manual')}
            disabled={busy}
            data-testid="login-take-over"
          >
            Sign in on the page instead
          </Button>
        )}
        <div className="flex items-center gap-2">
          <DeclineButton
            onDecline={(reason) => void decline(reason)}
            disabled={busy}
            label="Decline"
            showIcon={false}
            size="xs"
            className="border-border text-foreground hover:bg-muted"
            data-testid="login-decline"
          />
          <Button
            type="submit"
            form={formId}
            size="xs"
            className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
            loading={running === 'fill'}
            disabled={!complete || busy || !!unavailable}
            data-testid="login-submit"
          >
            {secret ? 'Sign in' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}
