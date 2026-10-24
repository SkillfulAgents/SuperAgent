/**
 * The container endpoints behind request_login. The agent maps a sign-in
 * form's fields by ref (the tool prepares them here); the host reads what to
 * draw, then posts the user's values, which are written straight into the
 * page. Values never pass through the CLI, whose argv and output reach logs
 * and the agent — only through our own CDP connection.
 *
 * Everything that touches the live browser comes in through `LoginRouteDeps`.
 */
import { randomUUID } from 'crypto'
import type { Hono } from 'hono'
import { inputManager } from './input-manager'
import { rememberInjectedSecret } from './injected-secrets'
import {
  awaitPageActivity,
  clickSubmitInPage,
  fillLogin,
  heldStates,
  lastFieldHasFocus,
  pageActivityNow,
  PageWatch,
  prepareLogin,
  preparePage,
  type HeldLoginField,
  type LoginFieldRequest,
  type LoginFillDeps,
  type PageActivity,
  type WrittenField,
} from './login-fill'
import { SECRET_LOGIN_FIELD_KINDS } from './login-form-script'
import {
  beginPreparedLogin,
  failPreparedLogin,
  forgetPreparedLogin,
  getPreparedLogin,
  putPreparedLogin,
  waitForPreparedLogin,
} from './login-requests'
import { loginFillRequestSchema, loginPrepareRequestSchema, type LoginFillReport } from './login-schema'

/** How the form gets submitted, and what the page did after. */
export interface SubmitPlan {
  submitRef: string | null
  /**
   * Checked right before the click or key press: what the page did by itself
   * since the fill, if anything — then nothing is clicked or pressed, since a
   * stale ref can resolve on the next page.
   */
  stillCurrent(): Promise<PageActivity | null>
  /** Click the submit control from inside the page (a banner covers it). */
  clickInPage(): Promise<boolean>
  /** Whether Enter pressed now would land in the last field written. */
  enterLandsInField(): Promise<boolean>
}

/** The CLI's answer to a command. */
export interface CliResult {
  exitCode: number
  stdout: string
}

/** The CLI refused a click because something else is over the target (a banner). */
const CLICK_INTERCEPTED = /covered by|intercept|obscured/i

export type SubmitClick<R extends CliResult> =
  | { clicked: 'cli'; result: R }
  | { clicked: 'in-page'; cliError: string }
  | { clicked: null; activity: PageActivity }
  | { clicked: null; result: R }

/**
 * Click the submit ref through the CLI; when a banner covers it, from inside
 * the page instead. The CLI's attempt takes its time, so the page is checked
 * once more before that second try: one that moved on by itself meanwhile
 * gets nothing.
 */
export async function clickSubmit<R extends CliResult>(
  plan: Pick<SubmitPlan, 'stillCurrent' | 'clickInPage'>,
  submitRef: string,
  cliClick: (ref: string) => Promise<R>,
): Promise<SubmitClick<R>> {
  const result = await cliClick(submitRef)
  if (result.exitCode === 0) return { clicked: 'cli', result }
  if (!CLICK_INTERCEPTED.test(result.stdout)) return { clicked: null, result }
  const activity = await plan.stillCurrent()
  if (activity) return { clicked: null, activity }
  if (await plan.clickInPage()) return { clicked: 'in-page', cliError: result.stdout }
  return { clicked: null, result }
}

export type SubmitOutcome =
  | { ok: true; submitted: NonNullable<LoginFillReport['submitted']>; observation: Record<string, unknown> }
  | { ok: true; submitted: null; activity: PageActivity; observation: Record<string, unknown> }
  | { ok: false; error: string }

export interface LoginRouteDeps {
  hostAuthEnabled(): boolean
  /** Null when the session may use the browser, else why not. */
  validateSession(sessionId: string): string | null
  browserActive(): boolean
  fillDeps(): LoginFillDeps
  /** Submit the filled form through the CLI and observe the page settle. */
  submit(plan: SubmitPlan): Promise<SubmitOutcome>
  /** The address bar's URL digest now, for a page that moved on by itself. */
  observeUrl(): Promise<Record<string, unknown> | null>
  notifyBrowserAction(): void
  /** How long the host's context read waits for the tool to finish locating fields. */
  contextWaitMs?: number
  /** How long a fill waits for the tool to open its request once the fields are located. */
  pendingWaitMs?: number
  /** How long to watch the page after the writes for it to submit the form itself. */
  pageSubmitWaitMs?: number
  /** The same after a one-time code, which a page may verify on its last digit, after a debounce. */
  codeSubmitWaitMs?: number
}

/** For the host's problem list: what was seen of a field just before the submit. */
const LOST_PROBLEMS: Record<LoginFillReport['lost'][number]['state'], string> = {
  differs: 'the field held a different value than was written',
  detached: 'the field was no longer in the page',
  unreadable: 'the field could not be read back',
}

/** Fold what the page did into the report: a submit event is a submission. */
function recordActivity(report: LoginFillReport, activity: PageActivity): void {
  if (activity.kind === 'submit') report.submitted = { via: 'page' }
  else report.pageActivity = activity
}

/** Kinds a field may be mapped without a ref for: a value entered now, for a later step. */
const HOLDABLE_KINDS = new Set<HeldLoginField['kind']>(['password', 'text'])

/**
 * The tool opens its request right after the fields are located; the host
 * can ask for a fill (from a saved account) in between. Wait out that gap.
 */
async function pendingLoginOpened(toolUseId: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs
  while (!inputManager.hasPendingOfType(toolUseId, 'login')) {
    if (Date.now() >= deadline || !getPreparedLogin(toolUseId)) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

export function registerLoginRoutes(app: Hono, deps: LoginRouteDeps): void {
  /** Sign-in requests being filled right now: one fill per request at a time. */
  const fillsInFlight = new Set<string>()

  // POST /browser/login/prepare - request_login locates the fields it mapped
  app.post('/browser/login/prepare', async (c) => {
    const parsed = loginPrepareRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'Invalid sign-in request', problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }, 400)
    }
    const body = parsed.data
    if (!beginPreparedLogin(body.toolUseId)) {
      return c.json({ error: 'This sign-in request was already prepared' }, 409)
    }
    const fail = (status: 409 | 422 | 500, problems: string[]) => {
      failPreparedLogin(body.toolUseId, problems)
      return c.json({ error: 'The sign-in fields could not be used', problems }, status)
    }
    const sessionError = deps.validateSession(body.sessionId)
    if (sessionError) return fail(409, [sessionError])
    if (!deps.browserActive()) return fail(409, ['no browser is open'])
    const located = body.fields.filter((field): field is LoginFieldRequest => field.ref !== undefined)
    const held: HeldLoginField[] = body.fields.filter((field) => field.ref === undefined).map(({ kind, label }) => ({ kind, label }))
    const unholdable = held.find((field) => !HOLDABLE_KINDS.has(field.kind))
    if (unholdable) {
      return fail(422, [`"${unholdable.label}" (${unholdable.kind}) has no ref: only a password or text field can be asked for ahead of its step`])
    }
    if (held.length > 0 && located.length === 0) {
      return fail(422, ['every field is mapped without a ref: a field without one is asked together with the fields on the page now'])
    }
    if (body.submitRef && located.length === 0) return fail(422, ['a submit ref needs at least one field mapped by ref'])
    try {
      const fillDeps = deps.fillDeps()
      if (body.submitRef) {
        if (located.some((field) => field.ref === body.submitRef)) {
          return fail(422, [`${body.submitRef} is mapped as a field and as the submit button`])
        }
        if (!(await fillDeps.boxOfRef(body.submitRef))) return fail(422, [`the box of the submit ref ${body.submitRef} could not be read`])
      }
      const result = located.length ? await prepareLogin(fillDeps, located) : await preparePage(fillDeps)
      if (!result.ok) return fail(422, result.problems)
      putPreparedLogin({
        toolUseId: body.toolUseId,
        sessionId: body.sessionId,
        origin: result.origin,
        url: result.url,
        topOrigin: result.topOrigin,
        fields: result.fields,
        held,
        providers: [...new Set(body.providers)],
        submitRef: body.submitRef,
        preparedAt: Date.now(),
      })
      return c.json({ origin: result.origin, url: result.url, topOrigin: result.topOrigin, fields: result.fields, held })
    } catch (error) {
      console.error('[Browser] Sign-in preparation failed:', error instanceof Error ? error.message : 'Unknown error')
      return fail(500, [`the page could not be read: ${error instanceof Error ? error.message : 'unknown error'}`])
    }
  })

  // GET /browser/login/context - the host reads what to draw: the frame's
  // origin and each field's kind, label and input hints. Never a value.
  app.get('/browser/login/context', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    const toolUseId = c.req.query('toolUseId')
    if (!toolUseId) return c.json({ error: 'toolUseId is required' }, 400)
    const entry = await waitForPreparedLogin(toolUseId, deps.contextWaitMs ?? 20_000)
    // Not known yet: the tool may still be locating the fields. The host retries.
    if (!entry) return c.json({ error: 'The sign-in form is still being located' }, 404)
    if ('problems' in entry) {
      return c.json({ error: 'The sign-in request could not be prepared', problems: entry.problems }, 409)
    }
    const { prepared } = entry
    return c.json({
      origin: prepared.origin,
      url: prepared.url,
      topOrigin: prepared.topOrigin,
      submit: prepared.submitRef !== null,
      fields: prepared.fields.map((field) => ({
        kind: field.kind,
        label: field.label,
        inputType: field.inputType,
        inputMode: field.inputMode,
        autocomplete: field.autocomplete,
        maxLength: field.maxLength,
      })),
      held: prepared.held,
      providers: prepared.providers,
    })
  })

  // POST /browser/login/fill - the host posts the user's values. Writes them,
  // submits, and answers the parked request_login call with what was observed.
  app.post('/browser/login/fill', async (c) => {
    if (!deps.hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503)
    // Never echo the body or its parse issues: they carry the values.
    const parsed = loginFillRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid sign-in fill request' }, 400)
    const body = parsed.data
    const prepared = getPreparedLogin(body.toolUseId)
    if (!prepared || !(await pendingLoginOpened(body.toolUseId, deps.pendingWaitMs ?? 3000))) {
      return c.json({ error: 'This sign-in request is no longer open' }, 409)
    }
    // The origin the host showed must be the one the browser located: the
    // last check before a value leaves for a page.
    if (prepared.origin !== body.expectedOrigin) {
      return c.json({ error: 'This sign-in request is for a different site' }, 409)
    }
    if (body.values.length !== prepared.fields.length) {
      return c.json({ error: 'One value per field is required' }, 400)
    }
    if (!body.values.some(Boolean)) return c.json({ error: 'Enter at least one value' }, 400)
    const sessionError = deps.validateSession(prepared.sessionId)
    if (sessionError) return c.json({ error: sessionError }, 409)
    if (!deps.browserActive()) return c.json({ error: 'Browser is not active' }, 409)
    if (fillsInFlight.has(body.toolUseId)) {
      return c.json({ error: 'This sign-in request is already being filled' }, 409)
    }

    fillsInFlight.add(body.toolUseId)
    try {
      // Before anything reads the page: every value but the identifier is
      // redacted from what the agent reads from here on.
      prepared.fields.forEach((field, index) => {
        if (SECRET_LOGIN_FIELD_KINDS.has(field.kind) && body.values[index]) rememberInjectedSecret(body.values[index])
      })
      const fillDeps = deps.fillDeps()
      const cdp = await fillDeps.connect()
      let report: LoginFillReport
      let watch: PageWatch | null = null
      try {
        // Watching starts before the first write, so whatever the page does
        // in reaction to the values is seen.
        watch = await PageWatch.start(cdp)
        const pageWatch = watch
        const fillId = randomUUID()
        const { outcomes, written, pageValues } = await fillLogin(fillDeps, cdp, prepared, body.values, fillId, async (field, element, value) => {
          // As written (a code without its spaces), which can differ from what was typed.
          if (SECRET_LOGIN_FIELD_KINDS.has(field.kind)) rememberInjectedSecret(value)
          await pageWatch.cover(element.sessionId)
        })
        for (const value of pageValues) rememberInjectedSecret(value)
        report = { type: 'filled', origin: prepared.origin, outcomes, lost: [], submitted: null, ...(body.account ? { account: body.account } : {}) }
        const refOf = (field: WrittenField) => prepared.fields[field.index].ref

        const failed = outcomes.some((outcome) => outcome.status === 'failed')
        if (!failed && written.length > 0) {
          const waitMs = written[written.length - 1].kind === 'otp'
            ? deps.codeSubmitWaitMs ?? 1000
            : deps.pageSubmitWaitMs ?? 400
          const activity = await awaitPageActivity(cdp, written, fillId, pageWatch, refOf, waitMs)
          if (activity) {
            recordActivity(report, activity)
            const digest = await deps.observeUrl()
            if (digest) report.observation = { digest }
          } else {
            // Read back once the page has had the beat to settle: code boxes can
            // read differently right after the write and take the code a moment
            // later (a framework applying it in an effect).
            const states = await heldStates(cdp, written)
            for (const readBack of states) {
              const field = written.find((candidate) => candidate.index === readBack.index)
              if (field && !field.kept && readBack.state === 'held') {
                field.kept = true
                outcomes[field.index].status = 'filled'
              }
            }
            // A password or code that still differs from what the user entered
            // is not theirs: submitting it would spend a code or a try.
            const changedSecrets = written
              .filter((field) => !field.kept && (field.kind === 'password' || field.kind === 'otp'))
              .map(refOf)
            if (changedSecrets.length) report.changedSecrets = changedSecrets
            const keptStates = states.filter(({ index }) => written.find((field) => field.index === index)?.kept)
            const locked = keptStates.find(({ state }) => state === 'locked')
            for (const readBack of keptStates) {
              if (readBack.state === 'held' || readBack.state === 'locked') continue
              report.lost.push({
                ref: prepared.fields[readBack.index].ref,
                state: readBack.state,
                ...(readBack.state === 'unreadable' ? { error: readBack.error } : {}),
              })
            }
            const clear = changedSecrets.length === 0 && report.lost.length === 0
            if (clear && locked) {
              // Disabled or read-only since the write: the page is busy with the values.
              recordActivity(report, { kind: 'locked', ref: prepared.fields[locked.index].ref })
            } else if (clear) {
              const submitRef = prepared.submitRef
              const outcome = await deps.submit({
                submitRef,
                stillCurrent: () => pageActivityNow(cdp, written, fillId, pageWatch, refOf),
                clickInPage: () => (submitRef ? clickSubmitInPage(fillDeps, cdp, submitRef, prepared.origin, written) : Promise.resolve(false)),
                enterLandsInField: () => lastFieldHasFocus(cdp, written, prepared.origin),
              })
              if (!outcome.ok) {
                report.submitError = outcome.error
              } else {
                if (outcome.submitted) report.submitted = outcome.submitted
                else recordActivity(report, outcome.activity)
                report.observation = outcome.observation
              }
            }
          }
        }
      } finally {
        watch?.close()
        cdp.close()
      }
      deps.notifyBrowserAction()
      // The answer goes to the agent; the fill is over either way, and a
      // failed fill is the agent's to act on (re-map, or hand over the browser).
      inputManager.resolve(body.toolUseId, JSON.stringify(report))
      forgetPreparedLogin(body.toolUseId)
      const count = (status: string) => report.outcomes.filter((outcome) => outcome.status === status).length
      const label = (ref: string) => prepared.fields.find((field) => field.ref === ref)?.label ?? ref
      return c.json({
        success: true,
        filled: count('filled') + count('changed'),
        failed: count('failed'),
        submitted: report.submitted !== null,
        problems: [
          ...report.outcomes.filter((outcome) => outcome.problem).map((outcome) => `${outcome.label}: ${outcome.problem}`),
          ...(report.changedSecrets ?? []).map((ref) => `${label(ref)}: the field held a different value than you entered, so nothing was clicked or pressed`),
          ...report.lost.map(({ ref, state }) => `${label(ref)}: ${LOST_PROBLEMS[state]}, so nothing was clicked or pressed`),
          ...(report.submitError ? [`${report.submitError.charAt(0).toUpperCase()}${report.submitError.slice(1)}`] : []),
        ],
      })
    } catch (error) {
      // Left open: the user can try again or take over the browser.
      console.error('[Browser] Sign-in fill failed:', error instanceof Error ? error.message : 'Unknown error')
      return c.json({ error: 'The sign-in form could not be filled' }, 500)
    } finally {
      fillsInFlight.delete(body.toolUseId)
    }
  })
}
