import { afterAll, describe, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createRequire } from 'module'
// eslint ships no bundled types and @types/eslint isn't a dependency; the
// RuleTester runtime API is all we need here.
// @ts-ignore -- no type declarations for 'eslint'
import { RuleTester } from 'eslint'
import rule from '../../../eslint-rules/no-floating-work.js'

// Drive ESLint's RuleTester through vitest's test hooks.
RuleTester.describe = describe as unknown as typeof RuleTester.describe
RuleTester.it = it as unknown as typeof RuleTester.it

// The rule reads types, so each case is parsed as a file of a real project.
const project = mkdtempSync(path.join(tmpdir(), 'no-floating-work-'))
writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, target: 'es2022', module: 'esnext', lib: ['es2022'], types: [] },
  include: ['file.ts'],
}))
writeFileSync(path.join(project, 'file.ts'), '')
afterAll(() => rmSync(project, { recursive: true, force: true }))

const ruleTester = new RuleTester({
  parser: createRequire(import.meta.url).resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json', tsconfigRootDir: project },
})

const filename = path.join(project, 'file.ts')
const DECLARATIONS = `
declare function work(): Promise<void>
declare function sync(): number
declare function background(work: Promise<unknown> | (() => Promise<unknown>), options: { name: string }): void
declare const pending: Promise<void>
declare const holder: { check: Promise<void>; reader?: { cancel(): Promise<void> } }
`
const at = (code: string) => ({ code: `${DECLARATIONS}\n${code}`, filename })
const voided = { messageId: 'void' }
const floating = { messageId: 'floating' }

ruleTester.run('no-floating-work', rule as unknown as Parameters<RuleTester['run']>[1], {
  valid: [
    // Awaited, returned, stored, or handed to background().
    at('async function f() { await work() }'),
    at('function f() { return work() }'),
    at('const p = work()'),
    at('let p: Promise<void>; p = work()'),
    at("background(work(), { name: 'x' })"),
    at("background(work().catch(() => {}), { name: 'x' })"),
    at("background(async () => { await work() }, { name: 'x' })"),
    at("setTimeout(() => background(work(), { name: 'x' }), 10)"),
    // A handler or cleanup attached to a promise that already exists.
    at('pending.catch(() => {})'),
    at('holder.check.catch(() => {}).finally(() => {})'),
    // Not a promise.
    at('void sync()'),
    at('sync()'),
    at('void pending.toString()'),
    at('function f(x: unknown) { void x }'),
  ],
  invalid: [
    { ...at('void work()'), errors: [voided] },
    { ...at('void work().catch(() => {})'), errors: [voided] },
    { ...at('void pending'), errors: [voided] },
    { ...at('void pending.then(() => {})'), errors: [voided] },
    { ...at('void holder.reader?.cancel()'), errors: [voided] },
    { ...at('void (async () => { await work() })()'), errors: [voided] },
    { ...at('setTimeout(() => void work(), 10)'), errors: [voided] },
    // A .catch() does not make dropped work any less dropped.
    { ...at('work().catch(() => {})'), errors: [floating] },
    { ...at('work().then(() => {}, () => {})'), errors: [floating] },
    { ...at('holder.reader?.cancel().catch(() => {})'), errors: [floating] },
    { ...at('Promise.resolve(work()).catch(() => {})'), errors: [floating] },
    { ...at("import('./file').catch(() => {})"), errors: [floating] },
    // A .then() continuation is new work, even on an existing promise.
    { ...at('pending.then(() => work(), () => {})'), errors: [floating] },
    { ...at('function f(ok: boolean) { ok && work().catch(() => {}) }'), errors: [floating] },
    // Unhandled is still dropped (no-floating-promises reports it too).
    { ...at('async function f() { work() }'), errors: [floating] },
  ],
})
