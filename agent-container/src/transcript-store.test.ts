import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadTranscriptStore, setTranscriptStore, transcriptStore } from './transcript-store'

describe('loadTranscriptStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-store-'))
  const moduleAt = (name: string, source: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, source)
    return file
  }

  afterEach(() => setTranscriptStore(undefined))

  it('keeps transcripts on the local disk only when no module is named', () => {
    loadTranscriptStore('')
    expect(transcriptStore()).toBeUndefined()
  })

  it("uses the module's default export as the store", async () => {
    loadTranscriptStore(moduleAt('store.cjs', 'exports.default = { append: async () => {}, load: async () => [{ type: "user" }] }'))
    expect(await transcriptStore()?.load({ projectKey: '-workspace', sessionId: 's-1' })).toEqual([{ type: 'user' }])
  })

  it('refuses a module that is not a store', () => {
    expect(() => loadTranscriptStore(moduleAt('broken.cjs', 'exports.default = { append: async () => {} }'))).toThrow('does not export a session store')
    expect(transcriptStore()).toBeUndefined()
  })
})
