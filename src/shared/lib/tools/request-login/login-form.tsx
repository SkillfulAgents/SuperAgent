import { forwardRef, useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { Eye, EyeOff, KeyRound, Lock, LockOpen, MousePointerClick } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from '../requests/decline-button'
import { BrowserCredentialPicker } from '../request-browser-input/browser-credential-picker'
import { partKeyOf } from '@shared/lib/browser-vault/vault-schemas'
import {
  compactLoginCode,
  isInsecureOrigin,
  loginFillResultSchema,
  siteLabel,
  type LoginContext,
  type LoginContextField,
  type LoginFieldKind,
  type LoginFieldSummary,
  type LoginVaultPayload,
  type VaultOffer,
} from './login-request'
import { loginRequestKey, recallLoginValues, setLoginRequestState } from './login-request-store'
import { OtherWaysToSignIn, providerChoices, SaveForLater, SavedAccountOffers, SignInViaPanel, SignInWithProviders } from './login-vault-sections'
import { LoginContextUnavailable, useLoginContext, useLoginRequestActions, useLoginVaultInfo } from './use-login-request'

interface LoginFormProps {
  agentSlug: string
  sessionId: string
  toolUseId: string
  /** The agent's fields, drawn (disabled) until the browser has located them. */
  fields: LoginFieldSummary[]
  /** How the host left the request: a named account, or a saved one that lacks some of what the page asks. */
  vault?: LoginVaultPayload
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
// Forwards its ref: a form whose first field is a password focuses it.
const SecretInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input> & { label: string }>(function SecretInput({ className, label, ...props }, ref) {
  const [show, setShow] = useState(false)
  const passwordInput = isElectron()
  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
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
})

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

/**
 * Which located fields a saved account fills: its username, and the parts it
 * holds — unless they may not go into this page (saved on https, the page on
 * plain HTTP), where the user types them. One that signs in through another
 * account fills no password.
 */
function coveredBy(offer: Pick<VaultOffer, 'parts' | 'via' | 'fillsHere'>, fields: LoginContext['fields']): Set<number> {
  const covered = new Set<number>()
  fields.forEach((field, index) => {
    if (field.kind === 'username') covered.add(index)
    const part = partKeyOf(field)
    if (part && offer.fillsHere !== false && offer.parts.includes(part) && !(offer.via && part === 'password')) covered.add(index)
  })
  return covered
}

/** Why the agent is asking again, when it is a retry: in the app's words, and the agent's own beneath. */
function retryNote(vault: LoginVaultPayload | undefined): { text: string; agentSays?: string } | null {
  if (!vault || vault.mode !== 'ask') return null
  const whose = vault.username ? ` for ${vault.username}` : ''
  if (vault.reason) return { text: 'The agent says the sign-in did not go through:', agentSays: vault.reason }
  if (vault.rejectedAt) return { text: `The site turned down the saved password${whose} on ${new Date(vault.rejectedAt).toLocaleDateString()}. Enter the current one to update it.` }
  if (vault.filledAt) {
    const at = new Date(vault.filledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return { text: `The saved password${whose} already went in at ${at}, and the agent is signing in again. If it was wrong, enter the current one.` }
  }
  return null
}

/** A saved account filling part of the form: the one the host left the request for, or one the user picked. */
interface FormAccount {
  id?: string
  username?: string
  covered: Set<number>
}

export function LoginForm({
  agentSlug,
  sessionId,
  toolUseId,
  fields: summaryFields,
  vault,
  autoFocus = false,
}: LoginFormProps) {
  const formId = useId()
  const errorId = `${formId}-error`
  const context = useLoginContext(agentSlug, sessionId, toolUseId)
  const { state, fill, signInVia, completeManually, decline } = useLoginRequestActions({ agentSlug, sessionId, toolUseId })
  const [mode, setMode] = useState<'form' | 'manual' | 'via'>('form')
  // The provider picked under "Or sign in with"; null for a saved account on another site.
  const [viaProvider, setViaProvider] = useState<string | null>(null)
  const [values, setValues] = useState<string[]>([])
  const [heldValues, setHeldValues] = useState<string[]>([])
  const [picked, setPicked] = useState<(VaultOffer & { covered: Set<number> }) | null>(null)
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null)
  const [saveUsername, setSaveUsername] = useState('')
  // What the server said the saved account could not fill after all: those
  // fields are asked for, and a saved account that is gone fills nothing.
  const [needed, setNeeded] = useState<ReadonlySet<number>>(new Set())
  const [accountGone, setAccountGone] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const located: LoginContext | undefined = context.data
  const unavailable = context.error instanceof LoginContextUnavailable ? context.error : null
  const vaultInfo = useLoginVaultInfo(agentSlug, sessionId, toolUseId, located !== undefined && !unavailable)
  const info = vaultInfo.data
  const site = info?.site ?? (located ? siteLabel(located.origin) : '')
  const otherMembers = info?.otherMembers ?? 0
  const choices = located && !unavailable && info ? providerChoices(info, site, located.providers) : null
  const pickProvider = (providerId: string | null) => {
    setViaProvider(providerId)
    setMode('via')
  }
  // On by default; on an agent other members use, an explicit choice (it shares the account).
  const save = saveChoice ?? otherMembers === 0

  // Prefill the identifier: the account the agent named, else this window's
  // memory of the last attempt.
  useEffect(() => {
    if (!located) return
    setValues((current) => {
      if (current.some(Boolean)) return current
      const recalled = recallLoginValues(agentSlug, sessionId, located.origin, located.fields)
      return vault?.username ? located.fields.map((field, index) => (field.kind === 'username' ? vault.username ?? '' : recalled[index])) : recalled
    })
  }, [agentSlug, sessionId, located, vault?.username])
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
  const error = state.status === 'idle' ? state.error : undefined
  const recovery = state.status === 'idle' ? state.recovery : undefined
  useEffect(() => {
    if (recovery?.reason === 'fields_needed') setNeeded((current) => new Set([...current, ...recovery.fields]))
    if (recovery?.reason === 'account_unavailable') {
      setAccountGone(true)
      setPicked(null)
    }
  }, [recovery])
  const fields: Array<LoginFieldSummary & Partial<LoginContextField>> = located?.fields ?? summaryFields
  const held = located?.held ?? []
  const account: FormAccount | null = picked
    ? { id: picked.id, username: picked.username, covered: picked.covered }
    : vault?.mode === 'complete' && !accountGone
      ? { id: vault.accountId, username: vault.username, covered: new Set(vault.covered ?? []) }
      : null
  const fillsField = (index: number) => account?.covered.has(index) === true && !needed.has(index)
  const retry = retryNote(vault)
  const shown = fields.flatMap((field, index) => (fillsField(index) ? [] : [{ field, index }]))
  const secret = fields.some((field) => field.kind === 'password' || field.kind === 'otp')
  const complete = located !== undefined && located.fields.length > 0 && shown.every(({ index }) => (values[index] ?? '').length > 0)
  const stillLocating = !located && !unavailable && context.failureCount > 1
  const usernameIndex = fields.findIndex((field) => field.kind === 'username')
  const identity = account?.username ||
    (usernameIndex >= 0 ? values[usernameIndex]?.trim() : '') ||
    vault?.username ||
    info?.identity ||
    null
  const askUsername = usernameIndex < 0 && !account?.username && !vault?.username && !info?.identity
  // Something here would land in the vault: an account (its username), or a part of one.
  const savable = held.length > 0 || shown.some(({ field }) => field.kind === 'username' || partKeyOf(field) !== null)
  const canSave = located !== undefined && located.fields.length > 0 && info !== undefined && !unavailable && savable
  // A saved login holds an identifier and a password: offered only when that
  // is all the page asks for. It goes straight into the page, never the form.
  const savedLoginFits = located !== undefined && located.fields.length > 0 && !account &&
    located.fields.every((field) => field.kind === 'username' || field.kind === 'password')
  const offers = !account && vault?.mode !== 'complete' ? info?.accounts ?? [] : []

  const fillOptions = (accountId?: string, granting = false) => ({
    ...(held.length && heldValues.some(Boolean) ? { heldValues: held.map((_, index) => heldValues[index] ?? '') } : {}),
    ...(canSave && save ? { save: true, ...(askUsername && saveUsername.trim() ? { username: saveUsername.trim() } : {}) } : {}),
    ...(accountId ? { accountId } : {}),
    // The notice was on screen where the user chose to save or to use a saved account.
    ...(otherMembers > 0 && ((canSave && save) || granting) ? { sharedAgentAcknowledged: true } : {}),
  })

  const submit = () => {
    if (!located || !complete || busy) return
    if (canSave && save && askUsername && !saveUsername.trim()) return
    const sent = located.fields.map((_, index) => (fillsField(index) ? '' : values[index] ?? ''))
    void fill(located, sent, fillOptions(account?.id, picked !== null && !picked.granted))
  }

  /** One click: an account that fills every field goes straight in; another is picked, and the rest is typed. */
  const useOffer = (offer: VaultOffer) => {
    if (!located || busy) return
    const covered = coveredBy(offer, located.fields)
    // It signs in through another account: there is nothing to type here
    // (unless the step asks only for what it holds besides, a workspace);
    // the agent is told which provider account to pick.
    if (offer.via?.id && (located.fields.length === 0 || covered.size < located.fields.length)) {
      void signInVia(located, { accountId: offer.via.id }, otherMembers > 0)
      return
    }
    if (covered.size === located.fields.length) {
      void fill(located, located.fields.map(() => ''), {
        accountId: offer.id,
        ...(otherMembers > 0 && !offer.granted ? { sharedAgentAcknowledged: true } : {}),
      })
      return
    }
    setPicked({ ...offer, covered })
    setValues(located.fields.map((field, index) => (field.kind === 'username' ? offer.username : covered.has(index) ? '' : values[index] ?? '')))
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

  if (mode === 'via' && located) {
    return (
      <div ref={rootRef}>
        <SignInViaPanel
          info={info}
          site={site}
          providerId={viaProvider}
          busy={busy}
          error={error}
          onSignInVia={(provider) => void signInVia(located, provider, otherMembers > 0)}
          onBack={() => setMode('form')}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="space-y-3 pt-4">
      <LoginSiteHeading context={located ?? null} />

      {retry && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-foreground" data-testid="login-retry-note">
          {retry.text}
          {retry.agentSays && <span className="mt-0.5 block break-words italic text-muted-foreground">{retry.agentSays}</span>}
        </p>
      )}

      {account?.username && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs text-foreground" data-testid="login-vault-account">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            Signing in as <span className="break-all font-medium">{account.username}</span>
            {account.covered.size > (usernameIndex >= 0 && account.covered.has(usernameIndex) ? 1 : 0) && (
              <span className="block text-2xs text-muted-foreground">The saved account fills the rest; enter what it does not have.</span>
            )}
          </span>
          {picked && (
            <button type="button" className="shrink-0 text-2xs text-muted-foreground underline" onClick={() => setPicked(null)} disabled={busy} data-testid="login-vault-account-clear">
              Use another
            </button>
          )}
        </div>
      )}

      {offers.length > 0 && located && (
        <SavedAccountOffers offers={offers} site={site} otherMembers={otherMembers} disabled={busy} onUse={useOffer} />
      )}

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
            {shown.map(({ field, index }) => {
              const inputId = `${formId}-field-${index}`
              const attributes = inputAttributes({ kind: field.kind, inputType: field.inputType ?? '', inputMode: field.inputMode ?? '' })
              const common = {
                ...attributes,
                id: inputId,
                ref: index === shown[0]?.index ? firstFieldRef : undefined,
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
            {held.length > 0 && (
              <div className="space-y-2.5 border-t border-border/60 pt-2.5" data-testid="login-held">
                <p className="text-2xs text-muted-foreground">For the next step: filled when {site} asks for it. Optional.</p>
                {held.map((field, index) => {
                  const inputId = `${formId}-held-${index}`
                  return (
                    <div key={index} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <label htmlFor={inputId} className="block min-w-0 truncate text-xs font-medium text-foreground">{field.label}</label>
                        <span className="shrink-0 text-2xs text-muted-foreground">{KIND_CHIPS[field.kind]}, next step</span>
                      </div>
                      <SecretInput
                        {...inputAttributes({ kind: field.kind, inputType: '', inputMode: '' })}
                        id={inputId}
                        name={`held-${field.kind}-${index}`}
                        label={field.label}
                        value={heldValues[index] ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const typed = event.target.value
                          setHeldValues((current) => {
                            const copy = [...current]
                            copy[index] = typed
                            return copy
                          })
                        }}
                        className="bg-background"
                        data-testid={`login-held-field-${index}`}
                      />
                    </div>
                  )
                })}
              </div>
            )}
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

        {located && !unavailable && located.fields.length > 0 && (
          <p className="text-2xs text-muted-foreground" data-testid="login-privacy">
            {privacyNote(siteLabel(located.origin), [...located.fields, ...held].map((field) => field.kind))}
          </p>
        )}
      </form>

      {canSave && (
        <SaveForLater
          checked={save}
          onCheckedChange={setSaveChoice}
          site={site}
          username={identity}
          askUsername={askUsername}
          usernameValue={saveUsername}
          onUsernameChange={setSaveUsername}
          otherMembers={otherMembers}
          disabled={busy}
        />
      )}

      {choices && choices.shown.length > 0 && (
        <SignInWithProviders
          choices={choices}
          lead={located?.fields.length ? 'Or sign in with' : 'Sign in with'}
          disabled={busy}
          onPick={pickProvider}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Not for this app's own page: typing the app's password there by hand
            would sign the agent's browser in to it. */}
        {unavailable?.forThisApp ? <span /> : (
          <div className="flex flex-wrap items-center gap-x-3">
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
            {choices && choices.shown.length === 0 && <OtherWaysToSignIn choices={choices} disabled={busy} onPick={pickProvider} />}
          </div>
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
          {(!located || located.fields.length > 0) && (
            <Button
              type="submit"
              form={formId}
              size="xs"
              className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
              loading={running === 'fill'}
              disabled={!complete || busy || !!unavailable || (canSave && save && askUsername && !saveUsername.trim())}
              data-testid="login-submit"
            >
              {secret ? 'Sign in' : 'Continue'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
