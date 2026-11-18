/**
 * Runs proxy rules in `node:vm` contexts inside a small pool of child
 * processes.
 *
 * The sandbox is for robustness, not for hostile code (rules are confirmed by
 * a person): the input is written by the agent, so a rule's own regex or loop
 * can be driven into a hang or a large allocation, and JSON keys like
 * `__proto__` must not reach a host object. So:
 *   - rules run in separate processes with a heap limit, never on the app's
 *     main thread. A process, not a worker thread: V8 aborts the whole
 *     process when one allocation overshoots a worker's heap limit, and a
 *     rule must never be able to take the app down. A process that runs out
 *     of memory, crashes or stops answering is replaced, and the rule's
 *     answer is "review";
 *   - a fresh context per evaluation (no state carried between requests);
 *   - no host object ever enters the context — the input crosses as a JSON
 *     string and the helpers are compiled from source inside it;
 *   - string code generation (eval / new Function) is disabled;
 *   - the rule's definition and its call each run under the timeout, and only
 *     a primitive string comes back out.
 *
 * Only a literal `true` allows. Anything else — false, a truthy non-boolean,
 * a promise, a throw, a timeout, running out of memory — is reported and
 * treated as "review".
 */
import vm from 'node:vm'
import { spawn, type ChildProcess } from 'node:child_process'
import { RULE_HELPERS_SOURCE } from './helpers-source'

export const RULE_TIMEOUT_MS = 50
/** Heap available to the rules in one sandbox process. */
const SANDBOX_HEAP_MB = 256
/** How long past the in-process timeouts the host waits before killing the process. */
const WATCHDOG_GRACE_MS = 250
/** Extra time a just-started process gets for its first job. */
const STARTUP_GRACE_MS = 5_000

export type RuleOutcome =
  | { result: 'true' }
  | { result: 'false' }
  | { result: 'non_boolean'; detail: string }
  | { result: 'threw'; detail: string }
  | { result: 'timeout' }
  | { result: 'invalid_code'; detail: string }

// The rule's own source compiles alone, so it can only produce a value: the
// runner (helpers included) is a separate script that reads that value.
function definitionSource(code: string): string {
  return `'use strict'; globalThis.__rule = (\n${code}\n)`
}

const RUNNER_SOURCE = `
globalThis.__helpers = ${RULE_HELPERS_SOURCE};
(function () {
  'use strict'
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (var key of Object.keys(value)) deepFreeze(value[key])
    }
    return value
  }
  try {
    var input = deepFreeze(JSON.parse(globalThis.__inputJson))
    var rule = globalThis.__rule
    if (typeof rule !== 'function') return 'invalid_code:rule is not a function'
    var result = rule(input, globalThis.__helpers)
    if (result === true) return 'true'
    if (result === false) return 'false'
    var kind = result === null ? 'null' : typeof result
    if (kind === 'object' && typeof result.then === 'function') kind = 'promise'
    return 'non_boolean:' + kind
  } catch (error) {
    var message
    try {
      message = error && typeof error === 'object' && typeof error.message === 'string'
        ? String(error.name || 'Error') + ': ' + error.message
        : String(error)
    } catch (_) {
      message = 'unprintable error'
    }
    return 'threw:' + message.slice(0, 500)
  }
})()
`

// Runs inside each sandbox process. Plain CommonJS, no imports from the app,
// so no bundler has to know about it. Sent over IPC (it is too long for a
// command line on Windows) and evaluated by BOOTSTRAP as a function of require.
const SANDBOX_SOURCE = `(function (require) {
'use strict'
const vm = require('node:vm')
const { types } = require('node:util')
const runner = new vm.Script(${JSON.stringify(RUNNER_SOURCE)}, { filename: 'proxy-rule-runner.js' })
const definitions = new Map()

function definitionFor(code) {
  let script = definitions.get(code)
  if (script) return script
  try {
    script = new vm.Script("'use strict'; globalThis.__rule = (\\n" + code + '\\n)', { filename: 'proxy-rule.js' })
  } catch (error) {
    script = { error: error && error.message ? String(error.message) : String(error) }
  }
  if (definitions.size > 500) definitions.clear()
  definitions.set(code, script)
  return script
}

// vm's timeout error, recognised without running rule code: a Proxy is
// rejected first (instanceof would run its traps) and 'code' is read from its
// own property descriptor.
function isTimeoutError(error) {
  if (typeof error !== 'object' || error === null || types.isProxy(error)) return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  return code !== undefined && 'value' in code && code.value === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

// The app went away: so does the sandbox.
process.on('disconnect', () => process.exit(0))

process.on('message', (job) => {
  const definition = definitionFor(job.code)
  if (!(definition instanceof vm.Script)) {
    process.send({ id: job.id, raw: 'invalid_code:' + definition.error })
    return
  }
  const sandbox = Object.create(null)
  sandbox.__inputJson = job.inputJson
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  let raw
  let phase = 'definition'
  const started = performance.now()
  try {
    // A definition that throws leaves __rule undefined; the runner reports it.
    try {
      definition.runInContext(context, { timeout: job.timeoutMs })
    } catch (error) {
      if (isTimeoutError(error)) throw error
    }
    phase = 'call'
    const value = runner.runInContext(context, { timeout: job.timeoutMs })
    raw = typeof value === 'string' ? value : 'non_boolean:' + typeof value
  } catch (error) {
    // The runner turns every rule error into a string inside the context, so
    // what reaches here is a timeout or a value that escaped it. The watchdog
    // can fire a hair early on this thread's clock, hence the elapsed check.
    raw = isTimeoutError(error) || performance.now() - started >= job.timeoutMs
      ? 'timeout'
      : 'threw:error escaped the rule sandbox (' + phase + ')'
  }
  process.send({ id: job.id, raw })
})
})`

const BOOTSTRAP = "process.once('message', (m) => require('node:vm').runInThisContext(m.source)(require))"

function spawnSandbox(): ChildProcess {
  return spawn(process.execPath, [`--max-old-space-size=${SANDBOX_HEAP_MB}`, '-e', BOOTSTRAP], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
    // Nothing from the app's environment: no credentials, no NODE_OPTIONS.
    // In Electron, the app binary runs as plain Node.
    env: {
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  })
}

interface Job {
  id: number
  code: string
  inputJson: string
  timeoutMs: number
  resolve: (outcome: RuleOutcome) => void
}

/** Keep a sandbox process from holding the app open while it has no job. */
function setHeld(child: ChildProcess, held: boolean): void {
  const channel = child.channel as { ref?: () => void; unref?: () => void } | null | undefined
  if (held) {
    child.ref()
    channel?.ref?.()
  } else {
    child.unref()
    channel?.unref?.()
  }
}

interface Sandbox {
  child: ChildProcess
  started: boolean
}

/**
 * A fixed number of sandbox processes, one job each at a time. A process
 * that crashes, runs out of memory or stops answering is killed and replaced;
 * its job answers "review" (threw / timeout).
 */
class RulePool {
  private idle: Sandbox[] = []
  private busy = new Map<Sandbox, { job: Job; watchdog: ReturnType<typeof setTimeout> }>()
  private queue: Job[] = []
  private spawned = 0

  constructor(private readonly size: number) {}

  run(job: Job): void {
    this.queue.push(job)
    this.pump()
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const sandbox = this.idle.pop() ?? (this.spawned < this.size ? this.spawn() : null)
      if (!sandbox) return
      const job = this.queue.shift()!
      const limit = 2 * job.timeoutMs + WATCHDOG_GRACE_MS + (sandbox.started ? 0 : STARTUP_GRACE_MS)
      const watchdog = setTimeout(() => this.fail(sandbox, { result: 'timeout' }), limit)
      watchdog.unref?.()
      this.busy.set(sandbox, { job, watchdog })
      setHeld(sandbox.child, true)
      sandbox.child.send({ id: job.id, code: job.code, inputJson: job.inputJson, timeoutMs: job.timeoutMs }, (error) => {
        if (error) this.fail(sandbox, { result: 'threw', detail: 'the rule sandbox could not be reached' })
      })
    }
  }

  private spawn(): Sandbox {
    this.spawned++
    const child = spawnSandbox()
    const sandbox: Sandbox = { child, started: false }
    child.on('message', (message: { id: number; raw: string }) => {
      const current = this.busy.get(sandbox)
      if (!current || current.job.id !== message.id) return
      clearTimeout(current.watchdog)
      this.busy.delete(sandbox)
      sandbox.started = true
      setHeld(child, false)
      this.idle.push(sandbox)
      current.job.resolve(parseRunnerResult(message.raw))
      this.pump()
    })
    child.on('error', (error) => {
      console.error('[proxy-rules] Rule sandbox failed:', error)
      this.fail(sandbox, { result: 'threw', detail: 'the rule sandbox failed' })
    })
    child.on('exit', (code, signal) => this.fail(sandbox, {
      result: 'threw',
      detail: signal === 'SIGKILL' ? 'the rule sandbox was stopped' : 'the rule crashed or ran out of memory',
    }))
    child.send({ source: SANDBOX_SOURCE })
    setHeld(child, false)
    return sandbox
  }

  /** Answer the process's job, drop the process, and keep the queue moving. */
  private fail(sandbox: Sandbox, outcome: RuleOutcome): void {
    const current = this.busy.get(sandbox)
    const known = current !== undefined || this.idle.includes(sandbox)
    if (!known) return
    if (current) {
      clearTimeout(current.watchdog)
      this.busy.delete(sandbox)
      current.job.resolve(outcome)
    }
    this.idle = this.idle.filter((s) => s !== sandbox)
    this.spawned--
    sandbox.child.kill('SIGKILL')
    this.pump()
  }
}

// Live requests and draft validation use separate pools, so validating an
// agent's slow draft never delays requests.
const pools = { evaluate: new RulePool(2), validate: new RulePool(1) }
let nextJobId = 1

export interface RunRuleOptions {
  timeoutMs?: number
  pool?: keyof typeof pools
}

/** Run a rule against an input already serialized with JSON.stringify. */
export function runRuleOnJson(code: string, inputJson: string, options: RunRuleOptions = {}): Promise<RuleOutcome> {
  const syntaxError = checkRuleSyntax(code)
  if (syntaxError) return Promise.resolve({ result: 'invalid_code', detail: syntaxError })
  return new Promise((resolve) => {
    pools[options.pool ?? 'evaluate'].run({
      id: nextJobId++,
      code,
      inputJson,
      timeoutMs: options.timeoutMs ?? RULE_TIMEOUT_MS,
      resolve,
    })
  })
}

export function runRule(code: string, input: unknown, options: RunRuleOptions = {}): Promise<RuleOutcome> {
  const inputJson = serializeRuleInput(input)
  if (typeof inputJson !== 'string') return Promise.resolve(inputJson)
  return runRuleOnJson(code, inputJson, options)
}

/** JSON for the sandbox, or the outcome to report when the input can't be serialized. */
export function serializeRuleInput(input: unknown): string | RuleOutcome {
  try {
    return JSON.stringify(input) ?? 'null'
  } catch (error) {
    return { result: 'threw', detail: `input not serializable: ${String(error)}` }
  }
}

const syntaxCache = new Map<string, string | null>()

/** Check that `code` compiles as a single expression (compiles only; runs nothing). */
export function checkRuleSyntax(code: string): string | null {
  const cached = syntaxCache.get(code)
  if (cached !== undefined) return cached
  let error: string | null = null
  try {
    new vm.Script(definitionSource(code), { filename: 'proxy-rule.js' })
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (syntaxCache.size > 500) syntaxCache.clear()
  syntaxCache.set(code, error)
  return error
}

function parseRunnerResult(raw: string): RuleOutcome {
  if (raw === 'true') return { result: 'true' }
  if (raw === 'false') return { result: 'false' }
  if (raw === 'timeout') return { result: 'timeout' }
  const colon = raw.indexOf(':')
  const kind = colon === -1 ? raw : raw.slice(0, colon)
  const detail = colon === -1 ? '' : raw.slice(colon + 1)
  if (kind === 'non_boolean') return { result: 'non_boolean', detail }
  if (kind === 'invalid_code') return { result: 'invalid_code', detail }
  return { result: 'threw', detail }
}
